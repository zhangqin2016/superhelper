import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/main/ipc-handlers.js', import.meta.url), 'utf8');
const start = source.indexOf('  ipcMain.handle("account:password-login"');
const end = source.indexOf('  ipcMain.handle("account:profile-update"', start);
async function run({ login = { ok: true, user: { id: 'dedicated-account' } }, refresh = { ok: true }, throws = false, disabled = false } = {}) {
  const calls = [];
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    accountDisabled: () => disabled,
    disabledAccountResult: () => ({ ok: false }),
    ctx: { scheduledTaskManager: { handlePrincipalChange: () => calls.push('scheduled-principal') }, turnOrchestrator: { handlePrincipalChange: () => calls.push('turn-principal') }, refreshCollaborationService: () => calls.push('collaboration'), runnerPool: {} },
    require(name) {
      if (name === './account-manager') return { loginWithPassword: async () => login };
      if (name === './ipc-utils') return { refreshRemoteConfigForSend: async options => { calls.push({ refresh: JSON.parse(JSON.stringify(options)) }); if (throws) throw new Error('refresh interrupted'); return refresh; } };
      if (name === './runner-live-config') return { terminateIdleRunners: () => calls.push('terminate-idle') };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return { result: JSON.parse(JSON.stringify(await handler({}, { loginName: 'dedicated-account', password: 'fixture' }))), calls };
}
const successful = await run();
assert.equal(successful.result.modelConfigReady, true, 'successful enterprise login must acquire its account-scoped signed configuration immediately');
assert.deepEqual(successful.calls.find(value => value.refresh)?.refresh, { force: true, timeoutMs: 45000, repairManagedService: true, refreshLicense: false, reason: 'account_login' });
assert.equal(successful.result.modelConfigError, '');
assert(successful.calls.includes('terminate-idle'), 'idle runners must adopt the new account configuration');
for (const scenario of [{ refresh: { ok: false, error: 'NETWORK_UNAVAILABLE' } }, { throws: true }]) {
  const outcome = await run(scenario);
  assert.equal(outcome.result.ok, true, 'configuration failure must preserve successful account login');
  assert.equal(outcome.result.user.id, 'dedicated-account');
  assert.equal(outcome.result.modelConfigReady, false);
  assert(outcome.result.modelConfigError);
  assert(!outcome.calls.includes('terminate-idle'));
}
const rejected = await run({ login: { ok: false, error: 'INVALID_CREDENTIALS' } });
assert.equal(rejected.calls.length, 0, 'failed credentials must not refresh config or change active principals');
assert.equal(rejected.result.error, 'INVALID_CREDENTIALS');
const disabled = await run({ disabled: true });
assert.equal(disabled.result.ok, false);
assert.equal(disabled.calls.length, 0, 'disabled login must not refresh configuration or change principals');
console.log('Password login: immediate scoped configuration, failed-refresh login preservation and invalid-credential fencing passed.');
