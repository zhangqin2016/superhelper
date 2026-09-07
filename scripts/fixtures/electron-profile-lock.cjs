// Minimal real Electron host: execute production profile setup, never the app.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
app.setPath('appData', process.env.LILY_LOCK_TEST_APP_DATA);
const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const start = source.indexOf('// Keep persisted app data stable');
const end = source.indexOf('app.setName(', start);
try {
  vm.runInNewContext(source.slice(start, end), { app, path, process });
  const acquired = app.requestSingleInstanceLock();
  process.stdout.write(`LILY_LOCK_RESULT ${JSON.stringify({ acquired, userData: app.getPath('userData') })}\n`);
  if (!acquired) app.exit(0);
  else {
    app.on('second-instance', () => {});
    process.stdin.resume();
    process.stdin.on('data', () => app.exit(0));
    setTimeout(() => app.exit(2), 30000);
  }
} catch (error) {
  process.stdout.write(`LILY_LOCK_RESULT ${JSON.stringify({ error: error.message })}\n`);
  app.exit(0);
}
