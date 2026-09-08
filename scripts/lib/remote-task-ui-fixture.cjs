"use strict";
// Isolated acceptance backend: real SQLite, ZIPs, task contract and IPC
// projections. Only transport/object storage and account directory are fixtures.
// This is not production/private-bucket or physical two-machine acceptance.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { CollaborationStore } = require("../../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../../src/main/collaboration/local-keyring");
const { createTaskCommands } = require("../../src/main/collaboration/task-commands");
const { createTaskWorkflow } = require("../../src/main/collaboration/task-workflow");
const { createTaskRecords } = require("../../src/main/collaboration/task-records");
const { createCollaborationIpc } = require("../../src/main/ipc-collaboration");
const { createTask, transitionTask } = require("../../server/src/services/collaboration/task-contract.cjs");

exports.createFixture = function createFixture(temporary) {
  const source = path.join(temporary, "Budget workspace");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "budget.txt"), "original budget\n");
  fs.writeFileSync(path.join(source, "remove.txt"), "remove only with consent\n");
  const serverTasks = new Map(), receipts = new Map(), objects = new Map(), uploads = new Map(), accounts = new Map();
  const events = [];
  const participants = ["owner", "helper"];
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const fail = code => Object.assign(new Error(code), { code });
  let clock = Date.now(), dropCreate = true;
  function account(accountId) {
    const keyring = new LocalCollaborationKeyring({ filePath: path.join(temporary, `${accountId}.keys`), safeStorage: {
      isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString(),
    } });
    const store = new CollaborationStore({ accountId, dbPath: path.join(temporary, `${accountId}.db`), keyring });
    store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES (?, 'chat', 'personal', 'direct', 0)", accountId);
    let stopped = false, opened = null;
    const assertActive = () => { if (stopped) throw fail("COLLAB_ACCOUNT_CHANGED"); };
    const deviceId = `${accountId}-device`;
    const getTask = async ({ taskId }) => {
      const task = serverTasks.get(taskId);
      if (!task || ![task.requesterUserId, task.assigneeUserId].includes(accountId)) throw fail("COLLAB_TASK_ACCESS_DENIED");
      return structuredClone(task);
    };
    const client = {
      getTask,
      listTasks: async ({ conversationId }) => [...serverTasks.values()].filter(t => t.conversationId === conversationId).map(t => structuredClone(t)),
      async submitTask(input) {
        assert.equal(input.deviceId, deviceId);
        const key = `${accountId}:${deviceId}:${input.clientCommandId}`, fingerprint = JSON.stringify(input);
        if (receipts.has(key)) {
          assert.equal(receipts.get(key).fingerprint, fingerprint, "retry preserves original command bytes");
          return structuredClone(receipts.get(key).response);
        }
        const { deviceId: _device, clientCommandId: _command, action, ...fields } = input;
        let task;
        if (action === "create") {
          assert.ok(objects.has(fields.inputSnapshotId));
          task = createTask({ ...fields, id: randomUUID() }, { actorUserId: accountId, authorizedParticipantIds: participants, now: ++clock });
        } else {
          const previous = await getTask({ taskId: fields.taskId });
          const { taskId, ...command } = fields, object = objects.get(command.deliveryId);
          task = transitionTask(previous, { action, ...command }, { actorUserId: accountId, authorizedParticipantIds: participants, now: ++clock,
            verifiedDelivery: object ? { id: command.deliveryId, taskId, inputSnapshotId: previous.inputSnapshotId, actorUserId: accountId, complete: true, manifestHash: hash(object.bytes) } : undefined });
        }
        serverTasks.set(task.id, task); events.push({ accountId, action, taskId: task.id });
        const response = { ok: true, result: { taskId: task.id, state: task.state, revision: task.revision } };
        receipts.set(key, { fingerprint, response });
        if (action === "create" && dropCreate) { dropCreate = false; throw fail("COLLAB_RESPONSE_UNKNOWN"); }
        return structuredClone(response);
      },
    };
    const tasks = createTaskCommands({ store, client, deviceId, assertActive });
    const workflow = createTaskWorkflow({ store, client, tasks, deviceId, assertActive, rootPath: path.join(temporary, "managed"),
      resolveProjectDirectory: id => id === "budget-project" ? source : undefined,
      chooseDirectory: async () => { events.push({ accountId, chooser: true }); return { canceled: false, filePaths: [source] }; },
      openWorkspace: input => { opened = input; return { projectId: "received-project", sessionId: "received-session" }; },
      transfers: { taskFiles: {
        async prepareUpload({ conversationId, inputPath, expectedPlaintextSha256 }) {
          const bytes = fs.readFileSync(inputPath); assert.equal(hash(bytes), expectedPlaintextSha256);
          const id = randomUUID(); uploads.set(id, { accountId, conversationId, bytes });
          return { ok: true, id, conversationId, scopeId: "personal", purpose: "workspace", direction: "upload", state: "prepared", completedParts: 0 };
        },
        async upload(id) {
          const upload = uploads.get(id); assert.equal(upload.accountId, accountId);
          if (!upload.objectId) {
            upload.objectId = randomUUID(); const packagePath = path.join(temporary, `${upload.objectId}.zip`);
            fs.writeFileSync(packagePath, upload.bytes); objects.set(upload.objectId, { ...upload, packagePath });
          }
          return { ok: true, id, conversationId: upload.conversationId, scopeId: "personal", purpose: "workspace", direction: "upload", state: "verified", objectId: upload.objectId, completedParts: 1 };
        },
        async download({ conversationId, taskId, objectId }) {
          const task = await getTask({ taskId }); assert.equal(task.conversationId, conversationId);
          assert.ok(task.inputSnapshotId === objectId || task.deliveries.some(d => d.id === objectId));
          return { ok: true, packagePath: objects.get(objectId).packagePath };
        },
      } },
    });
    const service = { ok: true, taskWorkflow: c => workflow.run(c), listTasks: c => tasks.list(c), getTask: c => tasks.get(c),
      changeTask: c => tasks.submit(c), getTaskCommands: c => tasks.pending(c), retryTask: c => tasks.retry(c) };
    const handlers = new Map();
    createCollaborationIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getService: () => service });
    const result = { records: createTaskRecords({ store, assertActive }), opened: () => opened,
      async invoke(channel, command) {
        assert.ok(handlers.has(channel), `unregistered IPC ${channel}`);
        events.push({ accountId, channel, operation: command?.operation, projectId: command?.projectId });
        return handlers.get(channel)({}, command);
      },
      close() { stopped = true; store.close(); },
    };
    accounts.set(accountId, result); return result;
  }
  return { source, serverTasks, events, uploads, account, close() { for (const value of accounts.values()) value.close(); } };
};
