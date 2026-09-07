// Explicit full-source Electron acceptance host; no business services are mocked.
// Launch with Electron, not node. Never starts an agent turn or handles a file picker.
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const check = (condition, code) => { if (!condition) throw new Error(code); };
const output = process.stdout.write.bind(process.stdout);
function report(value) { output(`${JSON.stringify(value)}\n`); }
try {
  check(args.length === 7 && args[0] === '--credentials' && args[2] === '--account-index' && args[4] === '--profile-root' && args[6] === '--allow-live-writes', 'EXPLICIT_FLAGS_REQUIRED');
  const credentialFile = path.resolve(args[1]), stat = fs.lstatSync(credentialFile);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size < 16384, 'PRIVATE_CREDENTIAL_FILE_REQUIRED');
  const credentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  const index = Number(args[3]);
  check(args[3] === '0' || args[3] === '1', 'ACCOUNT_INDEX_REQUIRED');
  const account = credentials.accounts?.[index];
  check(typeof account?.loginName === 'string' && typeof account.password === 'string', 'ACCOUNT_FIELDS_REQUIRED');
  const base = new URL(credentials.baseUrl);
  check(base.protocol === 'https:' && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'HTTPS_ORIGIN_REQUIRED');
  const root = args[5];
  check(path.isAbsolute(root) && fs.realpathSync(root) === root && fs.readdirSync(root).length === 0, 'NEW_EMPTY_REAL_PROFILE_REQUIRED');
  fs.chmodSync(root, 0o700);
  const userData = path.join(root, 'user-data'), home = path.join(root, 'home'), documents = path.join(root, 'documents');
  for (const directory of [userData, home, documents]) fs.mkdirSync(directory, { mode: 0o700 });
  // Virtual acceptance device identity: isolate only the macOS hardware probe.
  // Production device derivation, persisted keys, signatures and licensing code
  // remain unchanged. This is two virtual devices, not two physical machines.
  if (process.platform !== 'darwin') throw new Error('VIRTUAL_DEVICE_PLATFORM_UNSUPPORTED');
  const virtualHardwareId = require('node:crypto').randomUUID();
  fs.writeFileSync(path.join(userData, 'acceptance-hardware.json'), JSON.stringify({ hardwareIdentity: 'virtual-test-device', virtualHardwareId }), { flag: 'wx', mode: 0o600 });
  const childProcess = require('node:child_process');
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = (command, options) => {
    if (command !== 'ioreg -rd1 -c IOPlatformExpertDevice') return originalExecSync(command, options);
    const value = `"IOPlatformUUID" = "${virtualHardwareId}"`;
    return options?.encoding ? value : Buffer.from(value);
  };
  // End virtual acceptance device identity.
  Object.assign(process.env, { LILY_USER_DATA_DIR: userData, LILY_HOME: home, LILY_DOCUMENTS_DIR: documents,
    LILY_RUNTIME_CONTROL_FILE: path.join(root, 'runtime-control.json'), LILY_REAP_ORPHAN_SERVES: '0', LILY_SERVICE_API_BASE_URL: base.origin });
  delete process.env.LILY_DEBUG_RENDERER;
  app.setPath('userData', userData);
  app.setPath('home', home);
  app.setPath('documents', documents);
  // Suppress ordinary application stdout/stderr; do not persist potentially
  // sensitive exception diagnostics. Only our bounded projection reaches stdout.
  const privateWrite = (_chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  process.stdout.write = privateWrite;
  process.stderr.write = privateWrite;
  // Passive diagnostics around the real transport; responses and thrown errors
  // retain their original identity and no response body is consumed here.
  const transportPath = require.resolve('../src/main/proxy-aware-fetch');
  const transport = require(transportPath);
  let diagnostics = 0;
  const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : undefined;
  const observedTransport = async (...parameters) => {
    let endpoint = 'other_request';
    try {
      const url = new URL(parameters[0]);
      const known = ['/api/client/config', '/api/client/bootstrap', '/api/devices/register', '/api/auth/password/login'];
      if (url.origin === base.origin && known.includes(url.pathname)) endpoint = url.pathname;
    } catch { /* never echo an unrecognized URL */ }
    try {
      const response = await transport(...parameters);
      if (!response.ok && diagnostics++ < 20) report({ diagnostic: 'http_rejection', accountIndex: index, endpoint, status: response.status });
      return response;
    } catch (error) {
      const chromiumCode = String(error?.message || '').match(/\bERR_[A-Z_]+\b/)?.[0];
      if (diagnostics++ < 20) report({ diagnostic: 'transport_failure', accountIndex: index, endpoint, code: safeCode(error?.code) || safeCode(error?.cause?.code) || safeCode(chromiumCode) || 'TRANSPORT_FAILED' });
      throw error;
    }
  };
  observedTransport.proxyAwareFetch = observedTransport;
  require.cache[transportPath].exports = observedTransport;
  // Observe the real handler result without replacing its business behavior.
  let observedLogin;
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    if (channel !== 'account:password-login') return originalHandle(channel, handler);
    ipcMain.handle = originalHandle;
    return originalHandle(channel, async (...parameters) => {
      const result = await handler(...parameters);
      const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : undefined;
      observedLogin = { ok: result?.ok === true, modelConfigReady: result?.modelConfigReady === true,
        error: code(result?.error), modelConfigError: code(result?.modelConfigError) };
      return result;
    });
  };
  function failQuit() {
    process.exitCode = 1;
    app.once('will-quit', () => app.exit(1));
    setTimeout(() => app.exit(1), 3000);
    app.quit();
  }
  const startupTimeout = setTimeout(() => {
    report({ status: 'full_app_startup_timeout', accountIndex: index });
    failQuit();
  }, 120000);
  let loginStarted = false;
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', async () => {
      if (loginStarted || !contents.getURL().endsWith('/src/renderer/index.html')) return;
      loginStarted = true;
      try {
        const value = await contents.executeJavaScript(`(async () => {
          const wait = async (label, predicate) => { window.__lilyAcceptancePhase = label; const end = Date.now() + 60000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); } throw new Error(label); };
          await wait('ACCOUNT_MENU_BUTTON', () => document.getElementById('accountMenuBtn'));
          document.querySelector('.skill-preset-guide-later')?.click();
          const menuItem = await wait('ACCOUNT_MENU_OPEN', () => {
            const node = document.getElementById('accountMenuItemAccount');
            if (node?.getClientRects().length) return node;
            // A safe opening-only retry tolerates renderer listeners attaching
            // after document load; never toggle an already-open menu closed.
            const popover = document.getElementById('accountMenuPopover');
            if (popover?.hidden !== false) document.getElementById('accountMenuBtn').click();
            return false;
          });
          menuItem.click();
          await wait('ACCOUNT_SETTINGS_OPEN', () => document.getElementById('settingsPageAccount')?.hidden === false);
          document.getElementById('accountModePasswordBtn').click();
          const fields = ${JSON.stringify({ accountLoginNameInput: account.loginName, accountPasswordInput: account.password })};
          for (const [id, value] of Object.entries(fields)) { const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); }
          const button = await wait('PASSWORD_BUTTON_READY', () => { const node = document.getElementById('accountPasswordLoginBtn'); return node && !node.disabled && node.getClientRects().length && node; });
          button.click();
          await wait('PASSWORD_LOGIN_RESULT', () => {
            const status = document.getElementById('accountFormStatus');
            return (status?.classList.contains('settings-form-status--success') && document.getElementById('accountSignedInPanel')?.hidden === false)
              || status?.classList.contains('settings-form-status--error') || document.getElementById('accountPasswordChange')?.hidden === false;
          });
          const status = await window.assistantClient.getAccountStatus();
          const policy = await window.assistantClient.getAppPolicy();
          const { t } = await import('./i18n/index.js');
          const knownCodes = ['INVALID_CREDENTIALS', 'PASSWORD_LOCKED', 'USER_DISABLED', 'SERVICE_REQUEST_FAILED', 'ACCOUNT_FEATURE_DISABLED'];
          const errorText = document.getElementById('accountFormStatus')?.textContent || '';
          const error = knownCodes.find(code => t('settings.accountError.' + code) === errorText);
          const ok = status?.loggedIn === true && document.getElementById('accountSignedInPanel')?.hidden === false;
          // Clear submitted credentials before any screenshots, then close via the real control.
          document.getElementById('accountPasswordInput').value = '';
          if (ok) document.getElementById('settingsCloseBtn').click();
          return { ok, loggedIn: status?.loggedIn === true, passwordMustChange: status?.user?.passwordMustChange === true, taskPolicyReady: policy?.collaboration?.tasks === true, error: error || (ok ? undefined : 'LOGIN_UI_FAILED'), loginThroughDom: true };
        })()`);
        if (!value.ok || !value.loggedIn || value.passwordMustChange || !value.taskPolicyReady) {
          clearTimeout(startupTimeout);
          await contents.executeJavaScript(`for (const input of document.querySelectorAll('input[type="password"]')) input.value = '';`);
          const screenshot = path.join(root, 'failure-window.png');
          fs.writeFileSync(screenshot, (await contents.capturePage()).toPNG(), { mode: 0o600 });
          report({ status: 'full_app_login_failed', accountIndex: index, ...value, loginResult: observedLogin, screenshot });
          failQuit();
          return;
        }
        const policy = require('../src/main/remote-config').getRemoteCollaborationPolicySync();
        const ui = await contents.executeJavaScript(`(async () => {
          const sleep = () => new Promise(resolve => setTimeout(resolve, 250));
          const wait = async (predicate, label) => { window.__lilyAcceptancePhase = label; const end = Date.now() + 20000; while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(); } throw new Error(label); };
          const { t } = await import('./i18n/index.js');
          await wait(() => document.getElementById('accountMenuName')?.textContent === t('account.menu.signedIn'), 'SIDEBAR_ACCOUNT_STALE');
          document.querySelector('.skill-preset-guide-later')?.click();
          const toggle = await wait(() => { const node = document.getElementById('collaborationPanelToggle'); return node && !node.hidden && !node.disabled && node; }, 'PANEL_UNAVAILABLE');
          if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
          await wait(() => document.querySelector('.collaboration-inbox-item'), 'INBOX_EMPTY');
          const list = await window.assistantClient.collaboration.list();
          const candidates = (list.conversations || []).filter(item => item.scopeId === ${JSON.stringify(`team:${credentials.organizationId}`)} && item.title?.startsWith('Live acceptance ')).slice(0, 20);
          let selected;
          for (const conversation of candidates) {
            const result = await window.assistantClient.collaboration.listTasks(conversation.id);
            const task = result.tasks?.find(item => item.state === 'accepted');
            if (result.ok && task) { selected = { conversation, task }; break; }
          }
          if (!selected) throw new Error('ACCEPTED_TEST_TASK_MISSING');
          const row = [...document.querySelectorAll('.collaboration-inbox-item')].find(item => item.dataset.conversationId === selected.conversation.id);
          if (!row) throw new Error('TEST_CONVERSATION_ROW_MISSING');
          row.click();
          const entry = await wait(() => [...document.querySelectorAll('[data-action="task-entry"]')].find(item => !item.hidden && !item.disabled), 'TASK_BUTTON_UNAVAILABLE');
          entry.click();
          await wait(() => [...document.querySelectorAll('.remote-task-card')].find(item => item.dataset.taskId === selected.task.id), 'ACCEPTED_TASK_NOT_RENDERED');
          return { panelVisible: !document.getElementById('collaborationCenter').hidden, acceptedTaskRendered: true, sidebarSignedIn: true, candidateCount: candidates.length, conversationId: selected.conversation.id, taskId: selected.task.id };
        })()`);
        const screenshot = path.join(root, 'collaboration-accepted-task.png');
        fs.writeFileSync(screenshot, (await contents.capturePage()).toPNG(), { mode: 0o600 });
        clearTimeout(startupTimeout);
        report({ status: observedLogin?.modelConfigReady ? 'full_app_ui_passed' : 'full_app_ui_passed_config_degraded', accountIndex: index, hardwareIdentity: 'virtual-test-device', ...value, loginResult: observedLogin,
          collaboration: { enabled: policy.enabled === true, tasks: policy.tasks === true, workspaceShares: policy.workspaceShares === true }, ui, screenshot });
      } catch (error) {
        clearTimeout(startupTimeout);
        const message = String(error?.message || '');
        const known = ['ACCOUNT_MENU_BUTTON', 'ACCOUNT_MENU_OPEN', 'ACCOUNT_SETTINGS_OPEN', 'PASSWORD_BUTTON_READY', 'PASSWORD_LOGIN_RESULT', 'SIDEBAR_ACCOUNT_STALE', 'PANEL_UNAVAILABLE', 'INBOX_EMPTY', 'ACCEPTED_TEST_TASK_MISSING', 'TEST_CONVERSATION_ROW_MISSING', 'TASK_BUTTON_UNAVAILABLE', 'ACCEPTED_TASK_NOT_RENDERED'];
        let screenshot, phase;
        try {
          phase = await contents.executeJavaScript(`(() => { for (const input of document.querySelectorAll('input[type="password"]')) input.value = ''; return window.__lilyAcceptancePhase; })()`);
          screenshot = path.join(root, 'failure-window.png');
          fs.writeFileSync(screenshot, (await contents.capturePage()).toPNG(), { mode: 0o600 });
        } catch { /* never print raw renderer exceptions */ }
        report({ status: 'full_app_login_failed', accountIndex: index, code: known.find(code => message.includes(code)) || 'FULL_APP_UI_FAILED', phase: known.includes(phase) ? phase : undefined, loginResult: observedLogin, screenshot });
        failQuit();
      }
    });
  });
  process.stdin.resume();
  process.stdin.on('data', bytes => { if (String(bytes).trim() === 'quit') app.quit(); });
  require('../src/main.js');
} catch (error) {
  report({ status: 'failed', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'FULL_APP_START_FAILED' });
  app.exit(1);
}
