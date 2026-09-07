"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { taskView, taskCommand, taskTargets } = require("./task-view");
const { assertScopeWritable, isConversationRevoked } = require("./access-revocation");
const fail = (code = "COLLAB_TASK_UNAVAILABLE") => ({ ok: false, code });
const permanent = code => /^(COLLAB_TASK_(INVALID|ACCESS_DENIED|REVISION_CONFLICT|STATE_CONFLICT|DELIVERY_CONFLICT|REASON_REQUIRED|DELIVERY_UNVERIFIED|PACKAGE_UNAVAILABLE)|IDEMPOTENCY_KEY_REUSED)$/.test(code);

/** Commands are durable, reads are fresh. No task plaintext is broadcast or
 * cached across authorization changes; recovery never invents a new device. */
function createTaskCommands({ store, client, deviceId, assertActive, onChange = () => {} }) {
  const inFlight = new Map();
  const available = () => Boolean(store.db && client?.submitTask && client?.getTask && deviceId);
  function scope(conversationId) {
    assertActive();
    const conversation = store.getConversation({ conversationId });
    if (!conversation || isConversationRevoked(store, conversationId)) throw Object.assign(new Error("Revoked"), { code: "COLLAB_ACCESS_REVOKED" });
    assertScopeWritable(store, conversation.scopeId);
    return conversation.scopeId;
  }
  const get = id => {
    const row = store.db.get("SELECT * FROM task_commands WHERE account_id = ? AND id = ?", store.accountId, id);
    return row ? { ...row, ...store._decrypt({ scopeId: row.scope_id, recordId: `task-command:${row.id}`, value: row.payload_envelope_json }) } : null;
  };
  const view = row => ({ ok: true, clientCommandId: row.id, taskId: row.task_id, state: row.state === "submitting" || row.state === "queued" ? "confirming" : row.state, ...(row.code ? { code: row.code } : {}) });
  const save = (row, state, code = null, uncertain = true) => {
    scope(row.conversation_id);
    store.db.run("UPDATE task_commands SET state = ?, code = ?, uncertain = ?, updated_at = ? WHERE account_id = ? AND id = ?", state, code, Number(uncertain), store.now(), store.accountId, row.id);
    return { ...row, state, code, uncertain };
  };
  async function dispatch(id) {
    assertActive();
    let row = get(id);
    if (!row) return fail("COLLAB_ACCESS_REVOKED");
    scope(row.conversation_id);
    if (["completed", "failed"].includes(row.state)) return view(row);
    if (row.deviceId !== deviceId) return { ...view(row), code: "COLLAB_DEVICE_CHANGED" };
    const priorUncertain = Boolean(row.uncertain);
    row = save(row, "submitting");
    try {
      const response = await client.submitTask({ ...row.input, clientCommandId: row.id, deviceId });
      assertActive();
      if (!get(id)) return fail("COLLAB_ACCESS_REVOKED");
      scope(row.conversation_id);
      const result = response?.result;
      if (response?.ok !== true || result?.taskId !== row.task_id || result.revision !== row.input.expectedRevision + 1 || result.state !== taskTargets[row.input.action]) {
        throw Object.assign(new Error("Unknown receipt"), { code: "COLLAB_RESPONSE_UNKNOWN" });
      }
      row = save(row, "completed", null, false);
    } catch (error) {
      assertActive();
      if (!get(id)) return fail("COLLAB_ACCESS_REVOKED");
      const rejected = !priorUncertain && permanent(error.code);
      row = save(row, rejected ? "failed" : "confirming", rejected ? error.code : "COLLAB_RESPONSE_UNKNOWN", !rejected);
    }
    onChange();
    return view(row);
  }
  function retry({ clientCommandId }) {
    assertActive();
    if (!available()) return Promise.resolve(fail());
    if (inFlight.has(clientCommandId)) return inFlight.get(clientCommandId);
    const promise = Promise.resolve().then(() => dispatch(clientCommandId)).catch(error => fail(error.code));
    inFlight.set(clientCommandId, promise);
    promise.finally(() => { if (inFlight.get(clientCommandId) === promise) inFlight.delete(clientCommandId); }).catch(() => {});
    return promise;
  }
  return {
    async list({ conversationId }) {
      try {
        assertActive(); if (!available() || !client.listTasks) return fail(); scope(conversationId);
        const raw = await client.listTasks({ deviceId, conversationId });
        scope(conversationId);
        const tasks = Array.isArray(raw) && raw.length <= 50 ? raw.map(taskView) : null;
        if (!tasks || tasks.some(task => !task || task.conversationId !== conversationId || ![task.requesterUserId, task.assigneeUserId].includes(store.accountId))) return fail("COLLAB_TASK_INVALID");
        return { ok: true, tasks };
      } catch (error) { return fail(error.code); }
    },
    async get({ conversationId, taskId }) {
      try {
        assertActive(); if (!available()) return fail(); scope(conversationId);
        const task = taskView(await client.getTask({ deviceId, taskId }));
        scope(conversationId);
        return task && task.id === taskId && task.conversationId === conversationId && [task.requesterUserId, task.assigneeUserId].includes(store.accountId) ? { ok: true, task } : fail("COLLAB_TASK_INVALID");
      } catch (error) { return fail(error.code); }
    },
    pending({ conversationId }) {
      try {
        assertActive(); if (!available()) return fail(); scope(conversationId);
        return { ok: true, commands: store.db.all("SELECT * FROM task_commands WHERE account_id = ? AND conversation_id = ? AND state NOT IN ('completed','failed') ORDER BY created_at,id", store.accountId, conversationId).map(view) };
      } catch (error) { return fail(error.code); }
    },
    retry,
    async submit(command) {
      try {
        assertActive(); if (!available()) return fail();
        const normalized = taskCommand(command); if (!normalized) return fail("COLLAB_TASK_INVALID");
        const { conversationId, clientCommandId, ...input } = normalized;
        scope(conversationId);
        // Resolve immutable routing before choosing the journal encryption
        // scope. A renderer-supplied conversation must not misfile a Team
        // command under a personal key. This read cannot execute the intent.
        const target = taskView(await client.getTask({ deviceId, taskId: input.taskId }));
        const scopeId = scope(conversationId);
        if (!target || target.id !== input.taskId || target.conversationId !== conversationId
          || ![target.requesterUserId, target.assigneeUserId].includes(store.accountId)) return fail("COLLAB_TASK_ACCESS_DENIED");
        const fingerprint = createHash("sha256").update(JSON.stringify({ conversationId, input })).digest("hex");
        const id = store.db.transaction(() => {
          const existing = clientCommandId ? get(clientCommandId) : null;
          if (existing) return existing.fingerprint === fingerprint ? existing.id : null;
          // All windows share this SQLite constraint/check, not a renderer flag.
          const pending = store.db.get("SELECT * FROM task_commands WHERE account_id = ? AND task_id = ? AND state NOT IN ('completed','failed')", store.accountId, input.taskId);
          if (pending) return pending.fingerprint === fingerprint ? pending.id : false;
          const next = clientCommandId || randomUUID();
          const envelope = store._encrypt({ scopeId, recordId: `task-command:${next}`, value: { input, deviceId } });
          store.db.run("INSERT INTO task_commands(account_id,id,task_id,conversation_id,scope_id,fingerprint,state,payload_envelope_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)", store.accountId, next, input.taskId, conversationId, scopeId, fingerprint, envelope, store.now(), store.now());
          return next;
        })();
        return id ? retry({ clientCommandId: id }) : fail(id === false ? "COLLAB_TASK_PENDING" : "IDEMPOTENCY_KEY_REUSED");
      } catch (error) { return fail(error.code); }
    },
  };
}
module.exports = { createTaskCommands };
