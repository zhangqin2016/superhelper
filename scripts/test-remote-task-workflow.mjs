import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createTaskCommands } = require('../src/main/collaboration/task-commands');
const { createTaskWorkflow } = require('../src/main/collaboration/task-workflow');
const { createTaskRecords } = require('../src/main/collaboration/task-records');
const { revokeScope } = require('../src/main/collaboration/access-revocation');
const { createCollaborationIpc } = require('../src/main/ipc-collaboration');
const { taskWorkflowCommand, taskWorkflowResult } = require('../src/main/collaboration/task-workflow-view');
const { createTask, transitionTask } = require('../server/src/services/collaboration/task-contract.cjs');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-task-workflow-')));
const gitMode=process.env.LILY_TEST_GIT_PROTOCOL==='1';
const gitQueries=[];
const source = path.join(temporary, 'source'); fs.mkdirSync(source);
fs.writeFileSync(path.join(source, 'budget.txt'), 'original budget\n');
fs.writeFileSync(path.join(source, 'remove.txt'), 'remove after explicit consent\n');
const serverTasks = new Map(), receipts = new Map(), transfers = new Map(), objects = new Map();
const participants = ['owner', 'helper'];
let clock = 1, dropCreate = true, dropSubmit = true, rejectReplay = false, failNextPackage = false, createCalls = 0, createEvents = 0;
const offlineAccounts = new Set();
const err = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const opened = new Set();
function assemble(accountId,protocol=gitMode?1:undefined) {
  let stopped = false;
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(temporary, `${accountId}.keys`), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString(),
  } });
  const store = new CollaborationStore({ accountId, dbPath: path.join(temporary, `${accountId}.db`), keyring });
  for (const conversationId of ['chat', 'other']) store.db.run('INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES (?,?,?, ?,0)', accountId, conversationId, 'personal', 'direct');
  store.db.run('INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES (?,?,?,?,0)', accountId, 'team-chat', 'team:alpha', 'group');
  const assertActive = () => { if (stopped) throw err('COLLABORATION_STOPPED'); };
  const deviceId = `${accountId}-device`;
  const getTask = async ({ taskId }) => {
    if (offlineAccounts.has(accountId)) throw err('COLLAB_NETWORK_UNAVAILABLE');
    const task = serverTasks.get(taskId);
    if (!task || ![task.requesterUserId, task.assigneeUserId].includes(accountId)) throw err('COLLAB_TASK_ACCESS_DENIED');
    return clone(task);
  };
  const client = {
    async missingTaskGitObjects({taskId,deliveryId,haveCommits}) {
      gitQueries.push({accountId,taskId,deliveryId,haveCommits:[...haveCommits]});
      const task=await getTask({taskId});
      const wanted=[{objectId:task.inputSnapshotId,descriptor:task.inputGit}];
      if(deliveryId)wanted.push({objectId:deliveryId,descriptor:task.deliveries.find(item=>item.id===deliveryId)?.git});
      return {objects:wanted.filter(item=>!haveCommits.includes(item.descriptor.commit))};
    },
    getTask, listTasks: async ({ conversationId }) => [...serverTasks.values()].filter(task => task.conversationId === conversationId && [task.requesterUserId, task.assigneeUserId].includes(accountId)).map(clone),
    async submitTask(input) {
      assert.equal(input.deviceId, deviceId);
      const key = `${accountId}:${deviceId}:${input.clientCommandId}`, fingerprint = JSON.stringify(input);
      if (input.action === 'create') createCalls++;
      if (input.action === 'create' && rejectReplay) throw err('COLLAB_TASK_ACCESS_DENIED');
      if (input.action === 'create' && failNextPackage) { failNextPackage = false; throw err('COLLAB_TASK_PACKAGE_UNAVAILABLE'); }
      if (receipts.has(key)) {
        assert.equal(receipts.get(key).fingerprint, fingerprint, 'the original command is replayed byte for byte');
        return clone(receipts.get(key).response);
      }
      const { deviceId: ignoredDevice, clientCommandId: ignoredCommand, action, ...fields } = input;
      let task;
      if (action === 'create') {
        assert.ok(objects.has(fields.inputSnapshotId), 'input object is verified before creation');
        task = createTask({ ...fields, id: randomUUID() }, { actorUserId: accountId, authorizedParticipantIds: participants, now: clock++ });
        createEvents++;
      } else {
        const previous = await getTask({ taskId: fields.taskId });
        const { taskId, ...command } = fields;
        const object = objects.get(command.deliveryId);
        task = transitionTask(previous, { action, ...command }, { actorUserId: accountId, authorizedParticipantIds: participants, now: clock++,
          verifiedDelivery: object ? { id: command.deliveryId, taskId, inputSnapshotId: previous.inputSnapshotId, actorUserId: accountId, complete: true, manifestHash: digest(object.bytes) } : undefined });
      }
      serverTasks.set(task.id, task);
      const response = { ok: true, result: { taskId: task.id, state: task.state, revision: task.revision } };
      receipts.set(key, { fingerprint, response });
      if (action === 'create' && dropCreate) { dropCreate = false; throw err('COLLAB_RESPONSE_UNKNOWN'); }
      if (action === 'submit' && dropSubmit) { dropSubmit = false; throw err('COLLAB_RESPONSE_UNKNOWN'); }
      return clone(response);
    },
  };
  const tasks = createTaskCommands({ store, client, deviceId, assertActive });
  let lastOpened, changes = 0;
  const workflow = createTaskWorkflow({ store, writerLockPath:path.join(temporary,'writer.sqlite'), client, tasks, deviceId, assertActive, rootPath: path.join(temporary, 'managed'),
    taskGitProtocol:protocol,
    onChange: () => { changes++; },
    chooseDirectory: async () => ({ canceled: false, filePaths: [source] }),
    openWorkspace: async input => { lastOpened = input; return { projectId: 'project', sessionId: 'session' }; },
    // Network/object fixture with the real transfer-manager view shape. ZIP
    // capture, extraction, manifests, filesystem writes and SQLite are real.
    transfers: { taskFiles: {
      async prepareUpload({ conversationId, inputPath, originalName, expectedPlaintextSha256 }) {
        assert.ok(path.isAbsolute(inputPath));
        assert.equal(digest(fs.readFileSync(inputPath)), expectedPlaintextSha256, 'transfer admission binds the exact frozen package');
        const id = randomUUID(); transfers.set(id, { accountId, conversationId, originalName, bytes: fs.readFileSync(inputPath) });
        return { ok: true, id, conversationId, scopeId: 'personal', purpose: 'workspace', direction: 'upload', state: 'prepared', completedParts: 0 };
      },
      async upload(id) {
        const transfer = transfers.get(id); assert.equal(transfer.accountId, accountId);
        if (!transfer.objectId) {
          transfer.objectId = randomUUID(); const packagePath = path.join(temporary, `${transfer.objectId}.zip`);
          fs.writeFileSync(packagePath, transfer.bytes);
          objects.set(transfer.objectId, { ...transfer, packagePath });
        }
        return { ok: true, id, conversationId: transfer.conversationId, scopeId: 'personal', purpose: 'workspace', direction: 'upload', state: 'verified', objectId: transfer.objectId, completedParts: 1 };
      },
      async download({ conversationId, taskId, objectId }) {
        const task = await getTask({ taskId });
        assert.equal(task.conversationId, conversationId);
        assert.ok(task.inputSnapshotId === objectId || task.deliveries.some(value => value.id === objectId));
        return { ok: true, packagePath: objects.get(objectId).packagePath };
      },
    } },
  });
  const handlers = new Map(); const service = { ok: true, taskWorkflow: command => workflow.run(command) };
  createCollaborationIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getService: () => service });
  const api = { store, tasks, records: createTaskRecords({ store, assertActive }),
    run: command => handlers.get('collaboration:task-workflow')({}, command),
    lastOpened: () => lastOpened,
    changes: () => changes,
    close() { stopped = true; store.close(); opened.delete(api); },
  };
  opened.add(api); return api;
}
function ok(value, label) { assert.equal(value?.ok, true, `${label}: ${JSON.stringify(value)}`); return value; }
try {
  let owner = assemble('owner'), helper = assemble('helper');
  const initialChanges = owner.changes();
  for (let i = 0; i < 3; i++) {
    ok(await owner.run({ operation: 'drafts', conversationId: 'chat' }), 'read draft state');
    ok(await owner.run({ operation: 'recoveries' }), 'read recovery state');
  }
  assert.equal(owner.changes(), initialChanges, 'read-only refreshes must not emit a change and trigger another refresh');
  assert.equal(taskWorkflowCommand({ operation: 'prepare', conversationId: 'chat', sourceRoot: source }), null);
  assert.equal((await owner.run({ operation: 'prepare', conversationId: 'chat', path: source })).ok, false, 'IPC never grants arbitrary filesystem paths');
  const prepared = ok(await owner.run({ operation: 'prepare', conversationId: 'chat' }), 'prepare');
  assert.deepEqual(prepared.draft.files.map(file => file.path).sort(), ['budget.txt', 'remove.txt']);
  assert.doesNotMatch(JSON.stringify(prepared), /packagePath|snapshotRoot|sourceRoot|clientCommandId/);
  const draftId = prepared.draft.id;
  owner.close(); owner = assemble('owner');
  assert.equal(ok(await owner.run({ operation: 'drafts', conversationId: 'chat' }), 'restart draft').drafts[0].id, draftId);
  const send = { operation: 'send', conversationId: 'chat', draftId, assigneeUserId: 'helper', title: 'Budget review', objective: 'Revise budget', acceptanceCriteria: 'Verified totals' };
  assert.equal((await owner.run({ ...send, conversationId: 'other' })).ok, false, 'a draft cannot cross conversations');
  assert.equal(ok(await owner.run(send), 'lost create response').state, 'confirming');
  owner.close(); owner = assemble('owner');
  rejectReplay = true;
  assert.equal(ok(await owner.run(send), 'rejection after unknown outcome').state, 'confirming', 'a later rejection cannot disprove a prior commit');
  rejectReplay = false;
  const sent = ok(await owner.run(send), 'replayed create');
  assert.equal(sent.state, 'completed'); assert.equal(createEvents, 1); assert.equal(createCalls, 3);
  const taskId = sent.taskId;
  assert.equal(Boolean(serverTasks.get(taskId).inputGit),gitMode,'negotiated Git tasks carry a bound bundle descriptor');
  if(gitMode)assert.equal(objects.get(serverTasks.get(taskId).inputSnapshotId).bytes.subarray(0,15).toString(),'# v2 git bundle');
  assert.equal(owner.records.get(`task:${taskId}`).taskId, taskId, 'server task IDs bind separate private records');
  assert.equal((await helper.run({ operation: 'receive', conversationId: 'other', taskId })).ok, false);
  ok(await helper.tasks.submit({ conversationId: 'chat', taskId, action: 'accept', expectedRevision: 1 }), 'accept');
  if(gitMode){
    const {TaskGit}=require('../src/main/collaboration/task-git');
    const {createTaskGitTransport}=require('../src/main/collaboration/task-git-transport');
    const localGit=new TaskGit({rootPath:path.join(temporary,'managed',digest(Buffer.from('helper')),'git'),gitOptions:{autoInstall:false}});
    await createTaskGitTransport(localGit).importBundle({packagePath:objects.get(serverTasks.get(taskId).inputSnapshotId).packagePath,descriptor:serverTasks.get(taskId).inputGit});
  }
  ok(await helper.run({ operation: 'receive', conversationId: 'chat', taskId }), 'receive');
  if(gitMode)assert.deepEqual(gitQueries.find(query=>query.accountId==='helper'&&query.taskId===taskId).haveCommits,[],'bare local commit presence is not a verified task-object binding');
  ok(await helper.run({ operation: 'open', conversationId: 'chat', taskId }), 'open received workspace');
  const working = helper.lastOpened().rootPath, binding = helper.records.get(`task:${taskId}`);
  assert.ok(binding.gitBaseline?.commit, 'receive persists a real Git baseline');
  assert.equal(owner.records.get(`task:${taskId}`).gitBaseline?.commit,binding.gitBaseline.commit,'both parties independently reconstruct the same frozen baseline');
  assert.equal(execFileSync('git',['-C',working,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),binding.gitBaseline.commit);
  assert.notEqual(working, binding.snapshotRoot, 'the working directory is separate from the immutable baseline');
  assert.equal(fs.statSync(path.join(binding.snapshotRoot, 'budget.txt')).mode & 0o200, 0);
  assert.notEqual(fs.statSync(path.join(working, 'budget.txt')).mode & 0o200, 0, 'the received working copy must be writable');
  fs.writeFileSync(path.join(working, 'budget.txt'), 'reviewed budget\n');
  fs.unlinkSync(path.join(working, 'remove.txt'));
  fs.writeFileSync(path.join(working, 'evidence.txt'), 'totals verified\n');
  fs.writeFileSync(path.join(source,'private-local.txt'),'unrelated owner working edit');
  const {workRoot:unacknowledgedWorkRoot,...pendingWorktree}=helper.records.get(`task:${taskId}`);
  helper.records.put(`task:${taskId}`,pendingWorktree);
  helper.close(); helper = assemble('helper');
  ok(await helper.run({ operation:'receive',conversationId:'chat',taskId }), 'receive after restart');
  assert.equal(helper.records.get(`task:${taskId}`).workRoot,working);
  assert.equal(fs.readFileSync(path.join(working,'budget.txt'),'utf8'),'reviewed budget\n');
  assert.equal(fs.readFileSync(path.join(binding.snapshotRoot, 'budget.txt'), 'utf8'), 'original budget\n');
  fs.writeFileSync(path.join(working, 'budget.txt'), `fixture-only credential: sk-${'a'.repeat(24)}\n`);
  const omitted = await helper.run({ operation: 'prepareDelivery', conversationId: 'chat', taskId });
  assert.equal(omitted.code, 'COLLAB_TASK_DELIVERY_OMITTED', 'filtering an existing baseline file must not become a requested deletion');
  const blocked = helper.records.list('chat').find(record => record.kind === 'draft' && record.state === 'blocked');
  assert.ok(blocked);
  assert.equal((await helper.run({ operation: 'submitDelivery', conversationId: 'chat', taskId, draftId: blocked.id })).code, 'COLLAB_TASK_DELIVERY_OMITTED', 'a known blocked draft ID cannot bypass the omission guard');
  assert.equal(ok(await helper.run({ operation: 'drafts', conversationId: 'chat' }), 'blocked draft projection').drafts.some(draft => draft.id === blocked.id), false);
  fs.writeFileSync(path.join(working, 'budget.txt'), 'reviewed budget\n');
  const preparedDelivery = ok(await helper.run({ operation: 'prepareDelivery', conversationId: 'chat', taskId }), 'prepare delivery');
  const deliveryDraftId = preparedDelivery.draft.id;
  const contribution=helper.records.get(deliveryDraftId).gitContribution;
  const validatedDraft=helper.records.get(deliveryDraftId);
  const {gitContribution:unfinishedContribution,deliveryValidated:unfinishedValidation,...interruptedDraft}=validatedDraft;
  helper.records.put(deliveryDraftId,interruptedDraft);
  const transfersBeforeValidationRetry=transfers.size;
  assert.equal((await helper.run({operation:'submitDelivery',conversationId:'chat',taskId,draftId:deliveryDraftId})).code,'COLLAB_TASK_DELIVERY_NOT_VALIDATED','crash after freeze cannot bypass omitted-file validation');
  assert.equal(transfers.size,transfersBeforeValidationRetry);
  helper.records.put(deliveryDraftId,validatedDraft);
  assert.ok(contribution?.commit,'prepared delivery owns an immutable Git contribution');
  assert.equal(contribution.baseCommit,binding.gitBaseline.commit);
  assert.deepEqual(contribution.operations.map(entry=>entry.kind).sort(),['add','delete','modify']);
  assert.equal(execFileSync('git',['--git-dir',contribution.repository,'rev-parse',`${contribution.commit}^`],{encoding:'utf8'}).trim(),binding.gitBaseline.commit);
  assert.doesNotMatch(execFileSync('git',['--git-dir',contribution.repository,'ls-tree','-r','--name-only',contribution.commit],{encoding:'utf8'}),/private-local/);
  helper.close(); helper = assemble('helper');
  assert.equal(ok(await helper.run({ operation: 'drafts', conversationId: 'chat' }), 'restart delivery draft').drafts[0].id, deliveryDraftId);
  const submitCommand={operation:'submitDelivery',conversationId:'chat',taskId,draftId:deliveryDraftId};
  assert.equal(ok(await helper.run(submitCommand),'lost delivery response').state,'confirming');
  fs.writeFileSync(path.join(working,'budget.txt'),'later helper edit after uncertain delivery');
  helper.close();helper=assemble('helper');
  const submitted = ok(await helper.run(submitCommand), 'replay delivery after restart');
  assert.equal(submitted.state, 'completed');
  assert.equal(helper.records.get(deliveryDraftId).gitContribution.commit,contribution.commit,'restart and upload preserve the frozen contribution');
  const reviewTask = serverTasks.get(taskId), deliveryId = reviewTask.currentDeliveryId;
  if(gitMode){
    assert.equal(reviewTask.deliveries[0].git.commit,contribution.commit);
    assert.equal(objects.get(deliveryId).bytes.subarray(0,15).toString(),'# v2 git bundle');
  }
  assert.equal(reviewTask.state, 'review'); assert.ok(objects.has(deliveryId));
  ok(await owner.tasks.submit({ conversationId: 'chat', taskId, action: 'approve', expectedRevision: reviewTask.revision, deliveryId }), 'approve');
  assert.equal(fs.readFileSync(path.join(source, 'budget.txt'), 'utf8'), 'original budget\n', 'approval does not apply files');
  const preview = ok(await owner.run({ operation: 'preview', conversationId: 'chat', taskId, deliveryId }), 'preview');
  if(gitMode)assert.deepEqual(gitQueries.find(query=>query.accountId==='owner'&&query.taskId===taskId&&query.deliveryId===deliveryId).haveCommits,[binding.gitBaseline.commit],'requester reuses its verified input bundle');
  assert.deepEqual(preview.plan.entries.map(entry => entry.operation).sort(), ['add', 'delete', 'replace']);
  assert.doesNotMatch(JSON.stringify(preview), /rootPath|deliveryRoot|snapshotRoot|backupDirectory/);
  const apply = { operation: 'apply', conversationId: 'chat', taskId, deliveryId, applicationId: preview.applicationId, expectedPlanHash: preview.planHash, confirmDeletions: false };
  assert.equal((await owner.run(apply)).ok, false, 'deletion requires consent');
  assert.equal((await owner.run({ ...apply, conversationId: 'other', confirmDeletions: true })).ok, false, 'application records remain conversation bound');
  const applied = ok(await owner.run({ ...apply, confirmDeletions: true }), 'apply'); assert.equal(applied.state, 'applied');
  assert.equal(fs.readFileSync(path.join(source, 'budget.txt'), 'utf8'), 'reviewed budget\n');
  assert.equal(fs.existsSync(path.join(source, 'remove.txt')), false);
  assert.equal(fs.readFileSync(path.join(source, 'evidence.txt'), 'utf8'), 'totals verified\n');
  const repeatedPreview = ok(await owner.run({ operation: 'preview', conversationId: 'chat', taskId, deliveryId }), 'preview applied delivery again');
  assert.equal(repeatedPreview.applicationId, preview.applicationId, 'repeated preview must retain the original application and its rollback journal');
  assert.equal(repeatedPreview.planHash, preview.planHash);
  owner.close(); owner = assemble('owner');
  const applications = ok(await owner.run({ operation: 'drafts', conversationId: 'chat' }), 'restart application journal').applications;
  assert.equal(applications.find(value => value.applicationId === preview.applicationId).state, 'applied');
  const rollback = { operation: 'rollback', conversationId: 'chat', taskId, applicationId: preview.applicationId };
  offlineAccounts.add('owner');
  assert.equal(ok(await owner.run(rollback), 'rollback').state, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(source, 'budget.txt'), 'utf8'), 'original budget\n');
  assert.equal(fs.readFileSync(path.join(source, 'remove.txt'), 'utf8'), 'remove after explicit consent\n');
  assert.equal(fs.existsSync(path.join(source, 'evidence.txt')), false);
  assert.equal(ok(await owner.run(rollback), 'idempotent rollback').state, 'rolled_back');
  offlineAccounts.delete('owner');
  assert.equal(serverTasks.get(taskId).state, 'accepted', 'local rollback never rewrites server acceptance');
  const safe = taskWorkflowResult({ ok: true, rootPath: source, journal: { key: 'private' }, token: 'private' });
  assert.deepEqual(safe, { ok: true });
  const rejectedDraft = ok(await owner.run({ operation: 'prepare', conversationId: 'chat' }), 'prepare rejected draft');
  const rejected = await owner.run({ ...send, draftId: rejectedDraft.draft.id, assigneeUserId: 'owner' });
  assert.equal(rejected.state, 'failed', 'a definitive first-attempt self-assignment rejection is not an unknown commit');
  const failedRecord = owner.records.get(rejectedDraft.draft.id);
  assert.equal(failedRecord.state, 'failed');
  owner.close(); owner = assemble('owner');
  assert.equal(owner.records.get(rejectedDraft.draft.id).state, 'failed', 'definitive failure survives restart');
  const transferCount = transfers.size;
  const corrected = ok(await owner.run({ ...send, draftId: rejectedDraft.draft.id, title: 'Corrected recipient' }), 'correct rejected draft');
  assert.equal(corrected.state, 'completed');
  assert.notEqual(owner.records.get(rejectedDraft.draft.id).clientCommandId, failedRecord.clientCommandId, 'corrected input requires a new command identity');
  assert.equal(transfers.size, transferCount, 'corrected input reuses its frozen package and existing upload');

  const tampered = ok(await owner.run({ operation: 'prepare', conversationId: 'chat' }), 'prepare tampered package');
  const frozen = owner.records.get(tampered.draft.id);
  fs.chmodSync(frozen.packagePath, 0o600);
  const altered = fs.readFileSync(frozen.packagePath); altered[altered.length - 1] ^= 1;
  fs.writeFileSync(frozen.packagePath, altered);
  const transfersBeforeTamper = transfers.size;
  assert.equal((await owner.run({ ...send, draftId: frozen.id })).code, 'COLLAB_TASK_BUNDLE_CHANGED');
  assert.equal(transfers.size, transfersBeforeTamper, 'changed frozen bytes never reach transfer admission');

  const expired = ok(await owner.run({ operation: 'prepare', conversationId: 'chat' }), 'prepare expired package');
  failNextPackage = true;
  const unavailable = await owner.run({ ...send, draftId: expired.draft.id });
  assert.equal(unavailable.state, 'failed'); assert.equal(unavailable.code, 'COLLAB_TASK_PACKAGE_UNAVAILABLE');
  const expiredRecord = owner.records.get(expired.draft.id);
  const refreshed = ok(await owner.run({ ...send, draftId: expired.draft.id }), 'renew expired object');
  assert.equal(refreshed.state, 'completed');
  const renewedRecord = owner.records.get(expired.draft.id);
  assert.notEqual(renewedRecord.clientCommandId, expiredRecord.clientCommandId);
  assert.notEqual(renewedRecord.transferId, expiredRecord.transferId);
  assert.notEqual(renewedRecord.objectId, expiredRecord.objectId);
  assert.equal(renewedRecord.packagePath, expiredRecord.packagePath);
  assert.equal(renewedRecord.packageHash, expiredRecord.packageHash, 'object renewal preserves the frozen material approved by the user');

  const renameDraft=ok(await owner.run({operation:'prepare',conversationId:'chat'}),'prepare rename task');
  const renameTask=ok(await owner.run({...send,draftId:renameDraft.draft.id}),'send rename task').taskId;
  ok(await helper.tasks.submit({conversationId:'chat',taskId:renameTask,action:'accept',expectedRevision:1}),'accept rename task');
  ok(await helper.run({operation:'receive',conversationId:'chat',taskId:renameTask}),'receive rename task');
  const renameLocal=helper.records.get(`task:${renameTask}`),renameBefore=renameLocal.baseManifest[0];
  fs.renameSync(path.join(renameLocal.workRoot,renameBefore.path),path.join(renameLocal.workRoot,'renamed-edited.txt'));
  fs.writeFileSync(path.join(renameLocal.workRoot,'renamed-edited.txt'),'entirely rewritten after moving');
  helper.close();helper=assemble('helper');
  const renameDelivery=ok(await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:renameTask}),'prepare edited rename').draft;
  const renameContribution=helper.records.get(renameDelivery.id).gitContribution;
  assert.equal(renameContribution.operations.length,1);
  assert.equal(renameContribution.operations[0].kind,'rename','same file identity preserves edited rename across restart');
  assert.equal(renameContribution.operations[0].before.path,renameBefore.path);
  assert.equal(renameContribution.operations[0].after.path,'renamed-edited.txt');
  assert.notEqual(renameContribution.operations[0].before.sha256,renameContribution.operations[0].after.sha256);
  assert.doesNotMatch(JSON.stringify(renameDelivery),/fileIdentit|baseFileIdentit|birthtime|repository/,'device identities stay in encrypted main records');

  const deleteDraft = ok(await owner.run({operation:'prepare',conversationId:'chat'}),'prepare all-delete task');
  const deleteTask = ok(await owner.run({...send,draftId:deleteDraft.draft.id}),'send all-delete task').taskId;
  ok(await helper.tasks.submit({conversationId:'chat',taskId:deleteTask,action:'accept',expectedRevision:1}),'accept all-delete task');
  ok(await helper.run({operation:'receive',conversationId:'chat',taskId:deleteTask}),'receive all-delete task');
  const deleteLocal=helper.records.get(`task:${deleteTask}`);
  for (const file of deleteLocal.baseManifest) fs.unlinkSync(path.join(deleteLocal.workRoot,file.path));
  const filteredPath=path.join(deleteLocal.workRoot,deleteLocal.baseManifest[0].path);
  fs.writeFileSync(filteredPath,`fixture-only credential: sk-${'a'.repeat(24)}`);
  assert.equal((await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:deleteTask})).code,'COLLAB_TASK_DELIVERY_OMITTED','an entirely filtered snapshot cannot become all-delete');
  fs.unlinkSync(filteredPath);
  const emptyDelivery=ok(await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:deleteTask}),'prepare empty result').draft;
  assert.deepEqual(emptyDelivery.files,[]);
  const emptyContribution=helper.records.get(emptyDelivery.id).gitContribution;
  assert.equal(emptyContribution.operations.length,deleteLocal.baseManifest.length);
  assert.ok(emptyContribution.operations.every(entry=>entry.kind==='delete'));
  assert.equal(execFileSync('git',['--git-dir',emptyContribution.repository,'ls-tree','-r','--name-only',emptyContribution.commit],{encoding:'utf8'}),'');
  ok(await helper.run({operation:'submitDelivery',conversationId:'chat',taskId:deleteTask,draftId:emptyDelivery.id}),'submit empty result');
  const emptyReview=serverTasks.get(deleteTask),emptyId=emptyReview.currentDeliveryId;
  ok(await owner.tasks.submit({conversationId:'chat',taskId:deleteTask,action:'approve',expectedRevision:emptyReview.revision,deliveryId:emptyId}),'approve empty result');
  const emptyPreview=ok(await owner.run({operation:'preview',conversationId:'chat',taskId:deleteTask,deliveryId:emptyId}),'preview all-delete');
  const emptyApply={operation:'apply',conversationId:'chat',taskId:deleteTask,deliveryId:emptyId,applicationId:emptyPreview.applicationId,expectedPlanHash:emptyPreview.planHash};
  assert.equal((await owner.run({...emptyApply,confirmDeletions:false})).ok,false,'empty delivery still requires deletion consent');
  ok(await owner.run({...emptyApply,confirmDeletions:true}),'apply all-delete');
  for (const file of deleteLocal.baseManifest) assert.equal(fs.existsSync(path.join(source,file.path)),false);
  ok(await owner.run({operation:'rollback',conversationId:'chat',taskId:deleteTask,applicationId:emptyPreview.applicationId}),'undo all-delete');
  for (const file of deleteLocal.baseManifest) assert.equal(digest(fs.readFileSync(path.join(source,file.path))),file.sha256);

  fs.writeFileSync(path.join(source,'was-file'),'old file');
  fs.mkdirSync(path.join(source,'was-directory.txt'));
  fs.writeFileSync(path.join(source,'was-directory.txt/child.txt'),'old child');
  const shapeDraft=ok(await owner.run({operation:'prepare',conversationId:'chat'}),'prepare shape-change task');
  const shapeTask=ok(await owner.run({...send,draftId:shapeDraft.draft.id}),'send shape-change task').taskId;
  ok(await helper.tasks.submit({conversationId:'chat',taskId:shapeTask,action:'accept',expectedRevision:1}),'accept shape-change task');
  ok(await helper.run({operation:'receive',conversationId:'chat',taskId:shapeTask}),'receive shape-change task');
  const shapeLocal=helper.records.get(`task:${shapeTask}`),shapeRoot=shapeLocal.workRoot;
  fs.unlinkSync(path.join(shapeRoot,'was-file'));fs.mkdirSync(path.join(shapeRoot,'was-file'));
  fs.writeFileSync(path.join(shapeRoot,'was-file/new.txt'),'new child');
  fs.unlinkSync(path.join(shapeRoot,'was-directory.txt/child.txt'));fs.rmdirSync(path.join(shapeRoot,'was-directory.txt'));
  fs.writeFileSync(path.join(shapeRoot,'was-directory.txt'),'new file');
  fs.writeFileSync(path.join(shapeRoot,'was-directory.txt'),`fixture-only credential: sk-${'a'.repeat(24)}`);
  assert.equal((await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:shapeTask})).code,'COLLAB_TASK_DELIVERY_OMITTED','filtered ancestor replacement cannot delete baseline children');
  fs.unlinkSync(path.join(shapeRoot,'was-directory.txt'));
  const outside=path.join(temporary,'outside-empty');fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(shapeRoot,'was-directory.txt'));
  assert.equal((await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:shapeTask})).code,'COLLAB_TASK_DELIVERY_OMITTED','a skipped parent link must not look like missing baseline children');
  fs.unlinkSync(path.join(shapeRoot,'was-directory.txt'));fs.writeFileSync(path.join(shapeRoot,'was-directory.txt'),'new file');
  const unreadable=path.join(shapeRoot,'budget.txt');fs.chmodSync(unreadable,0o000);
  try {
    assert.throws(()=>fs.readFileSync(unreadable),error=>error.code==='EACCES','this test requires actual host permission denial');
    assert.equal((await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:shapeTask})).ok,false,'unreadable baseline material cannot silently become deletion');
  } finally {fs.chmodSync(unreadable,0o600);}
  const fullInventory=helper.records.get(`task:${shapeTask}`);
  helper.records.put(fullInventory.id,{...fullInventory,materializedPaths:fullInventory.materializedPaths.slice(1)});
  if(gitMode)ok(await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:shapeTask}),'a sparse inventory is representable on the Git protocol; unchanged absent entries are not deletions');
  else assert.equal((await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:shapeTask})).code,'COLLAB_TASK_PROTOCOL_UNAVAILABLE','legacy full-ZIP delivery cannot represent sparse input');
  helper.records.put(fullInventory.id,fullInventory);
  const shapeDelivery=ok(await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:shapeTask}),'prepare file-directory changes').draft;
  const shapeContribution=helper.records.get(shapeDelivery.id).gitContribution;
  assert.deepEqual(shapeContribution.operations.map(entry=>entry.kind).sort(),['add','add','delete','delete']);
  assert.equal(execFileSync('git',['--git-dir',shapeContribution.repository,'show',`${shapeContribution.commit}:was-file/new.txt`],{encoding:'utf8'}),'new child');
  assert.equal(execFileSync('git',['--git-dir',shapeContribution.repository,'show',`${shapeContribution.commit}:was-directory.txt`],{encoding:'utf8'}),'new file');

  if(gitMode){
    owner.close();owner=assemble('owner',0);
    const legacy=ok(await owner.run({operation:'prepare',conversationId:'chat'}),'prepare ZIP before protocol upgrade').draft;
    owner.close();owner=assemble('owner');
    const mixedTask=ok(await owner.run({...send,draftId:legacy.id}),'send preserved ZIP draft').taskId;
    assert.equal(serverTasks.get(mixedTask).inputGit,undefined,'enabling Git cannot change an existing ZIP draft');
    ok(await helper.tasks.submit({conversationId:'chat',taskId:mixedTask,action:'accept',expectedRevision:1}),'accept legacy task after upgrade');
    const mixedDelivery=ok(await helper.run({operation:'prepareDelivery',conversationId:'chat',taskId:mixedTask}),'prepare legacy delivery after upgrade').draft;
    assert.equal(helper.records.get(mixedDelivery.id).wireBundle,undefined);
    ok(await helper.run({operation:'submitDelivery',conversationId:'chat',taskId:mixedTask,draftId:mixedDelivery.id}),'submit preserved legacy delivery');
    const gated=ok(await owner.run({operation:'prepare',conversationId:'chat'}),'prepare Git before rollout disabled').draft;
    owner.close();owner=assemble('owner',0);
    const transferCountBeforeGate=transfers.size;
    assert.equal((await owner.run({...send,draftId:gated.id})).code,'COLLAB_TASK_PROTOCOL_UNAVAILABLE');
    assert.equal(transfers.size,transferCountBeforeGate,'disabled Git cannot upload a changed format');
    owner.close();owner=assemble('owner');
  }
  const teamDraft = ok(await owner.run({ operation: 'prepare', conversationId: 'team-chat' }), 'prepare Team task');
  const teamSent = ok(await owner.run({ ...send, conversationId: 'team-chat', draftId: teamDraft.draft.id }), 'send Team task');
  const teamTaskId = teamSent.taskId;
  ok(await helper.tasks.submit({ conversationId: 'team-chat', taskId: teamTaskId, action: 'accept', expectedRevision: 1 }), 'accept Team task');
  ok(await helper.run({ operation: 'open', conversationId: 'team-chat', taskId: teamTaskId }), 'receive Team workspace');
  fs.writeFileSync(path.join(helper.lastOpened().rootPath, 'budget.txt'), 'team revision\n');
  const teamDeliveryDraft = ok(await helper.run({ operation: 'prepareDelivery', conversationId: 'team-chat', taskId: teamTaskId }), 'prepare Team delivery');
  ok(await helper.run({ operation: 'submitDelivery', conversationId: 'team-chat', taskId: teamTaskId, draftId: teamDeliveryDraft.draft.id }), 'submit Team delivery');
  const teamReview = serverTasks.get(teamTaskId), teamDeliveryId = teamReview.currentDeliveryId;
  ok(await owner.tasks.submit({ conversationId: 'team-chat', taskId: teamTaskId, action: 'approve', expectedRevision: teamReview.revision, deliveryId: teamDeliveryId }), 'approve Team delivery');
  const teamPreview = ok(await owner.run({ operation: 'preview', conversationId: 'team-chat', taskId: teamTaskId, deliveryId: teamDeliveryId }), 'preview Team delivery');
  ok(await owner.run({ operation: 'apply', conversationId: 'team-chat', taskId: teamTaskId, deliveryId: teamDeliveryId, applicationId: teamPreview.applicationId, expectedPlanHash: teamPreview.planHash, confirmDeletions: false }), 'apply Team delivery');
  assert.equal(fs.readFileSync(path.join(source, 'budget.txt'), 'utf8'), 'team revision\n');
  revokeScope(owner.store, 'team:alpha');
  assert.equal(owner.records.get(teamPreview.applicationId), null, 'Team retirement removes the remote-scoped task journal');
  owner.close(); offlineAccounts.add('owner'); owner = assemble('owner');
  const recoveredList = ok(await owner.run({ operation: 'recoveries' }), 'discover recovery after Team retirement and restart');
  assert.ok(recoveredList.applications.some(item => item.applicationId === teamPreview.applicationId && item.conversationId === 'team-chat'));
  assert.doesNotMatch(JSON.stringify(recoveredList), /rootPath|deliveryRoot|backupDirectory|payload_envelope_json/);
  ok(await owner.run({ operation: 'rollback', conversationId: 'team-chat', taskId: teamTaskId, applicationId: teamPreview.applicationId }), 'offline rollback after Team retirement');
  assert.equal(fs.readFileSync(path.join(source, 'budget.txt'), 'utf8'), 'original budget\n');
  assert.equal(ok(await owner.run({ operation: 'recoveries' }), 'rolled-back recovery projection').applications.some(item => item.applicationId === teamPreview.applicationId), false);
  if(gitMode){
    // Inventory-first receive: above the lazy threshold only small files come to disk; the large asset is an online-only entry until materialized.
    const large=Buffer.alloc(4096,7);fs.writeFileSync(path.join(source,'large.bin'),large);
    process.env.LILY_COLLAB_LAZY_BYTES='1';process.env.LILY_COLLAB_LAZY_FILE_BYTES='1024';
    try{
      const lazyDraft=ok(await owner.run({operation:'prepare',conversationId:'chat'}),'prepare lazy task');
      const lazyTask=ok(await owner.run({...send,draftId:lazyDraft.draft.id}),'send lazy task').taskId;
      ok(await helper.tasks.submit({conversationId:'chat',taskId:lazyTask,action:'accept',expectedRevision:1}),'accept lazy task');
      ok(await helper.run({operation:'receive',conversationId:'chat',taskId:lazyTask}),'receive lazy task');
      const lazyLocal=helper.records.get(`task:${lazyTask}`);
      assert.equal(fs.existsSync(path.join(lazyLocal.workRoot,'large.bin')),false,'an online-only entry is never a placeholder on disk');
      assert.ok(lazyLocal.baseManifest.some(f=>f.path==='large.bin'),'the inventory still knows the file');
      assert.ok(lazyLocal.baseManifest.filter(f=>f.path!=='large.bin').every(f=>fs.existsSync(path.join(lazyLocal.workRoot,f.path))),'small files are materialized');
      const inventory=ok(await helper.run({operation:'inventory',conversationId:'chat',taskId:lazyTask}),'inventory').inventory;
      assert.equal(inventory.counts.remote,1);assert.equal(inventory.files[0].path,'large.bin');assert.equal(inventory.files[0].state,'remote');assert.equal(inventory.counts.remoteBytes,4096);
      assert.doesNotMatch(JSON.stringify(inventory),/workRoot|\/private\//,'the inventory projection carries relative paths only');
      const foreign=await owner.run({operation:'inventory',conversationId:'chat',taskId:lazyTask});
      assert.equal(foreign.ok,false,'only the assignee owns the task copy inventory');assert.match(foreign.code,/COLLAB_TASK_ACCESS_DENIED|COLLAB_NETWORK_UNAVAILABLE/);
      assert.equal((await helper.run({operation:'materialize',conversationId:'chat',taskId:lazyTask,paths:['nope.txt']})).code,'COLLAB_TASK_INVALID');
      const materialized=ok(await helper.run({operation:'materialize',conversationId:'chat',taskId:lazyTask,paths:['large.bin']}),'materialize').inventory;
      assert.equal(materialized.counts.remote,0);assert.deepEqual(fs.readFileSync(path.join(lazyLocal.workRoot,'large.bin')),large,'materialization writes the exact bytes');
      assert.equal(helper.records.get(`task:${lazyTask}`).materializedPaths.includes('large.bin'),true);
      assert.equal(ok(await helper.run({operation:'materialize',conversationId:'chat',taskId:lazyTask}),'materialize all is idempotent').inventory.counts.remote,0);
    }finally{delete process.env.LILY_COLLAB_LAZY_BYTES;delete process.env.LILY_COLLAB_LAZY_FILE_BYTES;fs.rmSync(path.join(source,'large.bin'),{force:true});}
  }
  console.log(`remote task workflow (${gitMode?'Git bundles':'ZIP'}): real two-account SQLite, manifests, response loss/replay, acceptance, writable import, delivery, apply and restart rollback passed (network/object fixture only)`);
} finally { for (const user of [...opened]) user.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
