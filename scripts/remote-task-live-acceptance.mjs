#!/usr/bin/env node
// Explicit opt-in production acceptance; deliberately excluded from test-* discovery.
// Credentials: {baseUrl, organizationId, accounts:[{loginName,password,newPassword?}, ...]}.
// Two isolated module clients on this host, not installed Electron/Windows clients.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stableStringify: stable, verifyDetached } = require('../src/main/crypto-signing');
const fail = code => Object.assign(new Error(code), { code });
const check = (condition, code) => { if (!condition) throw fail(code); };
const ok = (value, stage) => { check(value?.ok === true, `${stage}_${value?.code || 'FAILED'}`); return value; };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const uuid = () => crypto.randomUUID();
let stage = 'preflight';
const passed = [];
function pass(name) { passed.push(name); console.log(JSON.stringify({ stage: name, status: 'passed' })); }

function credentials(args) {
  check(args.length === 3 && args[0] === '--credentials' && ['--preflight', '--allow-live-writes'].includes(args[2]), 'EXPLICIT_FLAGS_REQUIRED');
  const file = path.resolve(args[1]);
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size < 16384, 'PRIVATE_CREDENTIAL_FILE_REQUIRED');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = new URL(input.baseUrl);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'HTTPS_ORIGIN_REQUIRED');
  check(typeof input.organizationId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(input.organizationId), 'ORGANIZATION_REQUIRED');
  check(Array.isArray(input.accounts) && input.accounts.length === 2, 'TWO_ACCOUNTS_REQUIRED');
  for (const account of input.accounts) check(typeof account.loginName === 'string' && account.loginName.length >= 3 && typeof account.password === 'string' && account.password.length > 0 && (!account.newPassword || typeof account.newPassword === 'string'), 'ACCOUNT_FIELDS_REQUIRED');
  check(input.accounts[0].loginName !== input.accounts[1].loginName, 'DISTINCT_ACCOUNTS_REQUIRED');
  return { ...input, baseUrl: url.origin, live: args[2] === '--allow-live-writes' };
}

async function main() {
  const config = credentials(process.argv.slice(2));
  pass('credential_preflight');
  const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
  const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
  const { createCollaborationClient } = require('../src/main/collaboration/client');
  const { createTransferRuntime } = require('../src/main/collaboration/transfer-runtime');
  const { createTaskCommands } = require('../src/main/collaboration/task-commands');
  const { createTaskWorkflow } = require('../src/main/collaboration/task-workflow');
  const { createTaskRecords } = require('../src/main/collaboration/task-records');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lily-live-task-')));
  fs.chmodSync(temporary, 0o700);
  const clients = [];
  // Keyring wrapping is real AES-GCM with ephemeral per-client memory keys.
  // This intentionally does not claim OS keychain or power-loss recovery coverage.
  function safeStorage() {
    const key = crypto.randomBytes(32);
    return { isEncryptionAvailable: () => true,
      encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
      decryptString(value) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8'); },
    };
  }
  const boundedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  async function assemble(account, index) {
    const root = path.join(temporary, String(index)); fs.mkdirSync(root, { mode: 0o700 });
    const deviceId = `live-task-${uuid()}`, keys = crypto.generateKeyPairSync('ed25519');
    const device = { deviceId, platform: process.platform, arch: process.arch, appVersion: 'live-task-acceptance', keyAlg: 'ed25519', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
    function signDeviceRequest({ path: pathname, method = 'POST', body }) {
      const timestamp = new Date().toISOString(), nonce = uuid(), bodyHash = hash(stable(body));
      return { 'x-lily-device-id': deviceId, 'x-lily-timestamp': timestamp, 'x-lily-nonce': nonce, 'x-lily-body-sha256': bodyHash,
        'x-lily-signature': crypto.sign(null, Buffer.from(stable({ method, pathname, timestamp, nonce, bodyHash })), keys.privateKey).toString('base64url') };
    }
    let dropCreate = false, createFingerprint = null, createCalls = 0;
    async function request(input) {
      check(config.live, 'OFFLINE_PREFLIGHT_NETWORK_FORBIDDEN');
      const endpoint = input.path.replace(/\/objects\/[^/]+\//, '/objects/:id/');
      const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : undefined;
      let response, json;
      try {
        response = await boundedFetch(`${config.baseUrl}${input.path}`, { method: input.method || 'POST', headers: { 'content-type': 'application/json', ...input.headers }, body: JSON.stringify(input.body), redirect: 'error' });
        json = await response.json();
      } catch (error) {
        console.error(JSON.stringify({ diagnostic: 'api_transport_failure', endpoint, status: response?.status,
          errorName: ['TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error', causeCode: safeCode(error?.cause?.code) }));
        throw error;
      }
      if (!response.ok || json.ok === false) console.error(JSON.stringify({ diagnostic: 'api_rejection', endpoint, status: response.status, code: safeCode(json.code) }));
      if (input.path === '/api/collaboration/v1/tasks' && input.body.action === 'create') {
        const fingerprint = hash(stable(input.body));
        if (createFingerprint) check(fingerprint === createFingerprint, 'CREATE_REPLAY_CHANGED');
        createFingerprint = fingerprint; createCalls++;
        if (dropCreate && response.ok && json.ok) { dropCreate = false; throw fail('SIMULATED_RESPONSE_LOSS'); }
      }
      return { ok: response.ok && json.ok !== false, status: response.status, json };
    }
    const login = config.live ? await request({ path: '/api/auth/password/login', body: { ...device, loginName: account.loginName, password: account.password } })
      : { json: { ok: true, accessToken: 'offline-construction-only', user: { id: `offline-account-${index}` } } };
    const auth = ok(login.json, 'LOGIN');
    check(auth.accessToken && auth.user?.id, 'LOGIN_IDENTITY_REQUIRED');
    if (auth.user.passwordMustChange) {
      check(account.newPassword, 'NEW_PASSWORD_REQUIRED');
      const input = { path: '/api/auth/password/change', method: 'POST', body: { deviceId, currentPassword: account.password, newPassword: account.newPassword } };
      ok((await request({ ...input, headers: { authorization: `Bearer ${auth.accessToken}`, ...signDeviceRequest(input) } })).json, 'PASSWORD_CHANGE');
    }
    if (config.live) {
      const publicKey = fs.readFileSync(new URL('../resources/license-public-key.pem', import.meta.url), 'utf8');
      for (const signedIn of [true, false]) {
        const input = { path: '/api/client/config', method: 'POST', body: { ...device, ...(signedIn ? { accountAccessToken: auth.accessToken } : {}) } };
        const result = ok((await request({ ...input, headers: signDeviceRequest(input) })).json, 'CONFIG');
        const { schemaVersion, configVersion, expiresAt, effectiveConfig } = result;
        check(verifyDetached({ schemaVersion, configVersion, expiresAt, effectiveConfig }, result.signature, publicKey), 'CONFIG_SIGNATURE_INVALID');
        check(Date.parse(expiresAt) > Date.now(), 'CONFIG_EXPIRED');
        const policy = effectiveConfig?.collaboration;
        check(signedIn ? policy?.enabled === true && policy.tasks === true && policy.workspaceShares === true
          : policy?.tasks !== true && policy?.workspaceShares !== true, 'SCOPED_CONFIG_POLICY_MISMATCH');
      }
      pass(`client_${index}_signed_scoped_config_enabled_anonymous_disabled`);
    }
    const client = createCollaborationClient({ expectedAccountId: auth.user.id, accountManager: { accountStatus: () => ({ loggedIn: true, user: auth.user }), accessTokenForService: async () => ({ ok: true, accessToken: auth.accessToken }) }, signDeviceRequest, request });
    const keyring = new LocalCollaborationKeyring({ filePath: path.join(root, 'keys.json'), safeStorage: safeStorage() });
    const store = new CollaborationStore({ accountId: auth.user.id, dbPath: path.join(root, 'store.db'), keyring });
    const assertActive = () => {};
    const transfers = createTransferRuntime({ store, client, deviceId, rootPath: path.join(root, 'collaboration-transfer'), policy: { enabled: true, tasks: true, workspaceShares: true, attachments: false }, assertActive, fetchImpl: boundedFetch });
    check(transfers.taskFiles, 'TRANSFER_RUNTIME_REQUIRED');
    const tasks = createTaskCommands({ store, client, deviceId, assertActive });
    const source = path.join(root, 'source'); fs.mkdirSync(source);
    let opened;
    const workflow = createTaskWorkflow({ store, client, deviceId, tasks, transfers, assertActive, rootPath: path.join(root, 'managed'), chooseDirectory: async () => ({ canceled: false, filePaths: [source] }), openWorkspace: async input => { opened = input; return { projectId: `live-${index}`, sessionId: `live-${index}` }; } });
    const item = { client, store, transfers, tasks, deviceId, source, userId: auth.user.id, run: command => workflow.run(command), records: createTaskRecords({ store, assertActive }), opened: () => opened, dropCreate: () => { dropCreate = true; }, createCalls: () => createCalls };
    clients.push(item); return item;
  }
  try {
    if (!config.live) {
      stage = 'offline_assembly';
      for (let index = 0; index < 2; index++) {
        const item = await assemble(config.accounts[index], index);
        ok(await item.run({ operation: 'recoveries' }), 'OFFLINE_WORKFLOW');
      }
      check(clients[0].store.accountId !== clients[1].store.accountId, 'OFFLINE_ACCOUNT_ISOLATION');
      pass('two_real_store_transfer_workflow_assemblies_no_network');
      return;
    }
    stage = 'login';
    const owner = await assemble(config.accounts[0], 0), helper = await assemble(config.accounts[1], 1);
    check(owner.userId !== helper.userId, 'DISTINCT_IDENTITIES_REQUIRED'); pass('two_real_account_logins');
    stage = 'conversation';
    const created = ok(await owner.client.submitConversation({ deviceId: owner.deviceId, clientCommandId: uuid(), action: 'create', scopeType: 'organization', organizationId: config.organizationId, kind: 'channel', visibility: 'private', title: `Live acceptance ${uuid()}`, memberUserIds: [helper.userId] }), 'CONVERSATION');
    const conversationId = created.result.conversationId;
    for (const item of clients) {
      const snapshot = await item.client.bootstrap({ deviceId: item.deviceId });
      item.store.replaceProjectionFromBootstrap(snapshot);
      check(item.store.getConversation({ conversationId }), 'BOOTSTRAP_CONVERSATION_MISSING');
    }
    pass('unique_private_conversation_and_real_bootstrap');
    stage = 'freeze_send_replay';
    fs.writeFileSync(path.join(owner.source, 'budget.txt'), 'original budget\n');
    fs.writeFileSync(path.join(owner.source, 'remove.txt'), 'explicit deletion sample\n');
    const prepared = ok(await owner.run({ operation: 'prepare', conversationId }), 'PREPARE');
    // Sending must retain the reviewed frozen bytes despite subsequent edits.
    fs.writeFileSync(path.join(owner.source, 'budget.txt'), 'owner changed after freezing\n');
    const send = { operation: 'send', conversationId, draftId: prepared.draft.id, assigneeUserId: helper.userId, title: `Live acceptance ${new Date().toISOString()}`, objective: 'Revise synthetic acceptance files', acceptanceCriteria: 'Exact add replace delete and rollback' };
    owner.dropCreate();
    check(ok(await owner.run(send), 'LOST_RESPONSE').state === 'confirming', 'LOST_RESPONSE_MUST_CONFIRM');
    const beforeReplay = await owner.client.listTasks({ deviceId: owner.deviceId, conversationId });
    const sent = ok(await owner.run(send), 'REPLAY'); check(sent.state === 'completed', 'REPLAY_NOT_COMPLETED');
    const taskId = sent.taskId;
    const afterReplay = await owner.client.listTasks({ deviceId: owner.deviceId, conversationId });
    check(owner.createCalls() === 2 && beforeReplay.length === afterReplay.length && afterReplay.filter(task => task.id === taskId).length === 1, 'REPLAY_DUPLICATED_TASK');
    pass('same_command_response_loss_replay_one_task');
    stage = 'private_bucket';
    let task = await owner.client.getTask({ deviceId: owner.deviceId, taskId });
    const ticket = await helper.client.objects.downloadTicket({ deviceId: helper.deviceId, clientCommandId: uuid(), objectId: task.inputSnapshotId });
    const anonymousUrl = new URL(ticket.url); anonymousUrl.search = '';
    const anonymous = await boundedFetch(anonymousUrl, { redirect: 'error' });
    check([401, 403].includes(anonymous.status), 'ANONYMOUS_OBJECT_NOT_DENIED'); await anonymous.body?.cancel();
    const authorized = await boundedFetch(ticket.url, { redirect: 'error' });
    check(authorized.ok, 'SIGNED_OBJECT_DOWNLOAD_FAILED');
    const ciphertext = Buffer.from(await authorized.arrayBuffer());
    check(ciphertext.length === ticket.ciphertextSize && hash(ciphertext) === ticket.ciphertextSha256, 'CIPHERTEXT_INTEGRITY_FAILED');
    pass('private_bucket_anonymous_denied_signed_hash_verified');
    stage = 'accept_receive';
    check(ok(await helper.tasks.submit({ conversationId, taskId, action: 'accept', expectedRevision: task.revision }), 'ACCEPT').state === 'completed', 'ACCEPT_NOT_COMPLETED');
    ok(await helper.run({ operation: 'receive', conversationId, taskId }), 'RECEIVE');
    ok(await helper.run({ operation: 'open', conversationId, taskId }), 'OPEN');
    const working = helper.opened().rootPath, baseline = helper.records.get(`task:${taskId}`).snapshotRoot;
    assert.equal(fs.readFileSync(path.join(working, 'budget.txt'), 'utf8'), 'original budget\n');
    assert.equal(fs.readFileSync(path.join(owner.source, 'budget.txt'), 'utf8'), 'owner changed after freezing\n');
    fs.writeFileSync(path.join(owner.source, 'budget.txt'), 'original budget\n');
    check(working !== baseline && (fs.statSync(path.join(baseline, 'budget.txt')).mode & 0o200) === 0, 'IMMUTABLE_BASELINE_REQUIRED');
    fs.writeFileSync(path.join(working, 'budget.txt'), 'reviewed budget\n'); fs.unlinkSync(path.join(working, 'remove.txt')); fs.writeFileSync(path.join(working, 'evidence.txt'), 'verified totals\n');
    assert.equal(fs.readFileSync(path.join(baseline, 'budget.txt'), 'utf8'), 'original budget\n');
    pass('real_transfer_decrypt_receive_independent_working_copy');
    stage = 'delivery_approve';
    const delivery = ok(await helper.run({ operation: 'prepareDelivery', conversationId, taskId }), 'PREPARE_DELIVERY');
    check(ok(await helper.run({ operation: 'submitDelivery', conversationId, taskId, draftId: delivery.draft.id }), 'DELIVERY').state === 'completed', 'DELIVERY_NOT_COMPLETED');
    task = await owner.client.getTask({ deviceId: owner.deviceId, taskId });
    const deliveryId = task.currentDeliveryId;
    check(task.state === 'review' && deliveryId, 'REVIEW_REQUIRED');
    check(ok(await owner.tasks.submit({ conversationId, taskId, action: 'approve', expectedRevision: task.revision, deliveryId }), 'APPROVE').state === 'completed', 'APPROVE_NOT_COMPLETED');
    assert.equal(fs.readFileSync(path.join(owner.source, 'budget.txt'), 'utf8'), 'original budget\n');
    pass('encrypted_delivery_approval_no_implicit_application');
    stage = 'preview_apply_rollback';
    const preview = ok(await owner.run({ operation: 'preview', conversationId, taskId, deliveryId }), 'PREVIEW');
    assert.deepEqual(preview.plan.entries.map(item => item.operation).sort(), ['add', 'delete', 'replace']);
    const apply = { operation: 'apply', conversationId, taskId, deliveryId, applicationId: preview.applicationId, expectedPlanHash: preview.planHash, confirmDeletions: false };
    const refused = await owner.run(apply);
    check(refused.ok === false && refused.code === 'COLLAB_TASK_APPLICATION_DELETION_CONFIRMATION_REQUIRED', 'DELETION_CONSENT_REQUIRED');
    assert.equal(fs.readFileSync(path.join(owner.source, 'budget.txt'), 'utf8'), 'original budget\n');
    assert.equal(fs.readFileSync(path.join(owner.source, 'remove.txt'), 'utf8'), 'explicit deletion sample\n');
    check(!fs.existsSync(path.join(owner.source, 'evidence.txt')), 'REFUSED_APPLY_CHANGED_FILES');
    check(ok(await owner.run({ ...apply, confirmDeletions: true }), 'APPLY').state === 'applied', 'APPLY_STATE');
    assert.equal(fs.readFileSync(path.join(owner.source, 'budget.txt'), 'utf8'), 'reviewed budget\n');
    check(!fs.existsSync(path.join(owner.source, 'remove.txt')), 'DELETE_NOT_APPLIED');
    assert.equal(fs.readFileSync(path.join(owner.source, 'evidence.txt'), 'utf8'), 'verified totals\n');
    check(ok(await owner.run({ operation: 'rollback', conversationId, taskId, applicationId: preview.applicationId }), 'ROLLBACK').state === 'rolled_back', 'ROLLBACK_STATE');
    assert.equal(fs.readFileSync(path.join(owner.source, 'budget.txt'), 'utf8'), 'original budget\n');
    assert.equal(fs.readFileSync(path.join(owner.source, 'remove.txt'), 'utf8'), 'explicit deletion sample\n');
    check(!fs.existsSync(path.join(owner.source, 'evidence.txt')), 'ADD_NOT_ROLLED_BACK');
    check((await owner.client.getTask({ deviceId: owner.deviceId, taskId })).state === 'accepted', 'ROLLBACK_CHANGED_REMOTE_TASK');
    pass('preview_explicit_apply_exact_rollback');
    console.log(JSON.stringify({ status: 'passed', passed, limits: ['two module clients on one host; not installed apps', 'ephemeral AES keyring adapter; not OS keychain', 'no Windows or power-loss test', 'synthetic task and encrypted objects remain on server'] }));
  } finally {
    for (const item of clients) { item.transfers.stop(); item.client.stop(); item.store.close(); }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
export const acceptanceRun = main().catch(error => {
  // Never print exception messages/stacks: HTTP errors may contain capabilities.
  const code = /^[A-Z][A-Z0-9_]{0,150}$/.test(error?.code || '') ? error.code : 'ACCEPTANCE_FAILED';
  console.error(JSON.stringify({ status: 'failed', stage, code, passed })); process.exitCode = 1;
});
