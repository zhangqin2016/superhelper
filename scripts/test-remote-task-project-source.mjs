import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createTaskWorkflow } = require('../src/main/collaboration/task-workflow');
const { createTaskRecords } = require('../src/main/collaboration/task-records');
const { taskWorkflowCommand, taskWorkflowResult } = require('../src/main/collaboration/task-workflow-view');
const { freezeTaskBundle, unpackTaskBundle } = require('../src/main/collaboration/task-bundle');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-task-project-')));
const source = path.join(temporary, 'workspace');
fs.mkdirSync(source);
fs.writeFileSync(path.join(source, 'budget.txt'), 'original budget\n');
const command = { operation: 'prepare', conversationId: 'chat', projectId: 'project_1' };
const stores = [];
function fixture({ resolve, choose, afterFreeze } = {}) {
  const dir = fs.mkdtempSync(path.join(temporary, 'account-'));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString(),
  } });
  const store = new CollaborationStore({ accountId: 'owner', dbPath: path.join(dir, 'cache.db'), keyring });
  stores.push(store);
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('owner','chat','team:alpha','group',0)");
  let stopped = false, chosen = 0, resolved = 0, frozen = 0;
  const assertActive = () => { if (stopped) throw Object.assign(new Error('stopped'), { code: 'COLLAB_ACCOUNT_CHANGED' }); };
  const workflow = createTaskWorkflow({ store, assertActive, deviceId: 'device', rootPath: path.join(dir, 'managed'),
    resolveProjectDirectory: async id => { resolved++; assert.equal(id, command.projectId); return resolve ? resolve(store) : source; },
    chooseDirectory: async () => { chosen++; return choose ? choose(store) : { filePaths: [source] }; },
    bundle: { unpackTaskBundle, async freezeTaskBundle(input) {
      frozen++; const result = await freezeTaskBundle(input); await afterFreeze?.(store); return result;
    } },
    client: { submitTask() { assert.fail('preparation must not send'); } },
    transfers: { taskFiles: { prepareUpload() { assert.fail('preparation must not upload'); } } },
  });
  return { store, workflow, records: createTaskRecords({ store, assertActive }), stop() { stopped = true; },
    counts: () => ({ chosen, resolved, frozen }) };
}
try {
  assert.deepEqual(taskWorkflowCommand(command), command, 'prepare accepts a registered project identity');
  for (const projectId of ['', null, undefined, '../private', source, 'a/b', 'a\\b', 'a'.repeat(201), {}, 1]) {
    assert.equal(taskWorkflowCommand({ ...command, projectId }), null, 'explicit project IDs must be identifiers');
  }
  for (const field of ['path', 'rootPath', 'sourceRoot', 'filePaths', 'arbitrary']) {
    assert.equal(taskWorkflowCommand({ ...command, [field]: source }), null, 'renderer never chooses a filesystem path');
  }
  const owner = fixture();
  const prepared = await owner.workflow.run(command);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.deepEqual(prepared.draft.files.map(file => file.path), ['budget.txt']);
  assert.deepEqual(owner.counts(), { chosen: 0, resolved: 1, frozen: 1 });
  const record = owner.records.get(prepared.draft.id);
  assert.equal(record.sourceRoot, source);
  assert.equal(fs.readFileSync(path.join(record.snapshotRoot, 'budget.txt'), 'utf8'), 'original budget\n');
  assert.ok(fs.statSync(record.packagePath).size > 0);
  assert.doesNotMatch(JSON.stringify(taskWorkflowResult(prepared)), /sourceRoot|snapshotRoot|packagePath/);
  assert.equal(JSON.stringify(taskWorkflowResult(prepared)).includes(source), false, 'safe projection never contains the absolute source directory');
  assert.ok(!JSON.stringify(owner.store.db.all('SELECT * FROM task_workspace_records')).includes(source), 'source binding remains encrypted');
  const legacy = fixture();
  assert.equal((await legacy.workflow.run({ operation: 'prepare', conversationId: 'chat' })).ok, true);
  assert.deepEqual(legacy.counts(), { chosen: 1, resolved: 0, frozen: 1 });
  const canceled = fixture({ choose: () => ({ canceled: true }) });
  assert.deepEqual(await canceled.workflow.run({ operation: 'prepare', conversationId: 'chat' }), { ok: true, cancelled: true });
  for (const resolve of [() => null, () => path.join(temporary, 'deleted'), () => path.join(source, 'budget.txt')]) {
    const missing = fixture({ resolve });
    assert.equal((await missing.workflow.run(command)).ok, false, 'unknown/deleted/non-directory project fails');
    assert.equal(missing.counts().chosen, 0, 'never fall back to another directory');
    assert.equal(missing.counts().frozen, 0);
  }
  const invalidations = [
    store => { store.accountId = 'different'; },
    store => { store.db.run("INSERT INTO revoked_scopes(account_id,scope_id,key_delete_pending) VALUES ('owner','team:alpha',0)"); },
    store => { store.db.run("INSERT INTO revoked_conversations(account_id,conversation_id,scope_id) VALUES ('owner','chat','team:alpha')"); },
    store => { store.db.run("UPDATE conversations SET scope_id = 'team:beta' WHERE account_id = 'owner' AND id = 'chat'"); },
  ];
  for (const invalidate of invalidations) {
    for (const legacyPath of [false, true]) {
      const blocked = fixture(legacyPath ? { choose: async store => { invalidate(store); return { filePaths: [source] }; } }
        : { resolve: async store => { invalidate(store); return source; } });
      assert.equal((await blocked.workflow.run(legacyPath ? { operation: 'prepare', conversationId: 'chat' } : command)).ok, false);
      assert.equal(blocked.counts().frozen, 0, 'authority lost across directory await must stop before reading files');
    }
    const blocked = fixture({ afterFreeze: async store => invalidate(store) });
    assert.equal((await blocked.workflow.run(command)).ok, false, 'authority is rechecked before committing frozen draft');
    assert.equal(blocked.store.db.get('SELECT COUNT(*) AS n FROM task_workspace_records').n, 0);
  }
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const stopped = fixture({ resolve: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const pending = stopped.workflow.run(command);
  await waiting; stopped.stop(); release(source);
  assert.equal((await pending).ok, false);
  assert.equal(stopped.counts().frozen, 0);
  console.log('remote task project source: strict IPC identity, real frozen files/encrypted binding, chooser baseline and async authority fences passed');
} finally {
  for (const store of stores) store.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
