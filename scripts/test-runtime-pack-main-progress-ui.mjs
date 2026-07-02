import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

const installer = read("src/main/runtime-pack-installer.js");
assert.match(installer, /const activeInstalls = new Map\(\)/);
assert.match(installer, /function installingRuntimePackIds\(\)/);
assert.match(installer, /BrowserWindow/);
assert.match(installer, /joined: true/);

const ipcRuntimePacks = read("src/main/ipc-runtime-packs.js");
assert.doesNotMatch(ipcRuntimePacks, /event\.sender\.send\("runtime-packs:progress"/);

const preflight = read("src/main/runtime-pack-preflight.js");
assert.match(preflight, /installingRuntimePackIds/);
assert.match(preflight, /installingPacks/);

const preflightUi = read("src/renderer/modules/runtime-pack-preflight-ui.js");
assert.match(preflightUi, /dependencyInstallWaiting/);
assert.match(preflightUi, /installingPacks/);

const progressUi = read("src/renderer/modules/runtime-pack-progress.js");
assert.match(progressUi, /onRuntimePackProgress/);
assert.match(progressUi, /runtime-pack-progress-main/);
assert.match(progressUi, /runtimeProgress\.title/);

const app = read("src/renderer/app.js");
assert.match(app, /initRuntimePackProgress/);

const css = read("src/renderer/styles/overlays.css");
assert.match(css, /\.runtime-pack-progress-main/);
assert.doesNotMatch(css, /var\(--danger\)/);

for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(read(`src/renderer/i18n/locales/${locale}.json`));
  for (const key of [
    "composer.dependencyInstallWaiting",
    "runtimeProgress.title",
    "runtimeProgress.multiple",
    "runtimeProgress.done",
    "runtimeProgress.failed",
    "runtimeProgress.bytes",
  ]) {
    assert.ok(messages[key], `${locale} missing ${key}`);
  }
}

console.log("runtime pack main progress UI static checks passed");
