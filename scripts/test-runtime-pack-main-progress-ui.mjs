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
assert.match(preflight, /agentAdvisory/);

const preflightUi = read("src/renderer/modules/runtime-pack-preflight-ui.js");
assert.match(preflightUi, /dependencyInstallWaiting/);
assert.match(preflightUi, /installingPacks/);

const composer = read("src/renderer/modules/composer.js");
assert.doesNotMatch(composer, /ensureRuntimePacksBeforeSend/);
assert.doesNotMatch(composer, /ensureRuntimePacks\s*\(/);

const turnOrchestrator = read("src/main/turn-orchestrator.js");
assert.match(turnOrchestrator, /buildRuntimePackAdvisory/);
assert.match(turnOrchestrator, /dependencyAdvisory/);

const progressUi = read("src/renderer/modules/runtime-pack-progress.js");
assert.match(progressUi, /onRuntimePackProgress/);
assert.match(progressUi, /runtime-pack-progress-main/);
assert.match(progressUi, /ACTIVE_VISIBLE_PHASES/);
for (const phase of ["resolving", "downloading", "verifying", "extracting", "health-checking", "refreshing", "installed", "failed"]) {
  assert.match(progressUi, new RegExp(`\\b${phase.replace("-", "\\-")}\\b`));
}
assert.doesNotMatch(progressUi, /MAIN_VISIBLE_PHASES = new Set\(\["failed"\]\)/);
assert.match(progressUi, /latestVisibleProgress/);
assert.match(progressUi, /runtimeProgress\.multiple/);
// The home surface shows a small ring by the sidebar settings button — never
// a floating banner (background plumbing must not shout at the user).
assert.match(progressUi, /settingsBtn/, "ring anchors next to the sidebar settings button");
assert.match(progressUi, /openSettingsPage\("runtime"\)/, "clicking the ring opens Settings → dependencies");
assert.match(progressUi, /stroke-dashoffset/, "progress renders as an SVG ring");
assert.match(progressUi, /FAILED_CLEAR_MS/, "failed states auto-clear instead of persisting forever");
assert.match(progressUi, /insertAdjacentElement\("afterend", root\)/, "ring inserts beside the settings button");

const app = read("src/renderer/app.js");
assert.match(app, /initRuntimePackProgress/);

const css = read("src/renderer/styles/overlays.css");
assert.match(css, /\.runtime-pack-progress-main/);
assert.doesNotMatch(css, /var\(--danger\)/);

for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(read(`src/renderer/i18n/locales/${locale}.json`));
  for (const key of [
    "composer.dependencyInstallWaiting",
    "runtimeProgress.failed",
    "runtimeProgress.bytes",
    "runtimeProgress.preparing",
    "runtimeProgress.refreshing",
    "runtimeProgress.ready",
    "runtimeProgress.degraded",
  ]) {
    assert.ok(messages[key], `${locale} missing ${key}`);
  }
}

console.log("runtime pack main progress UI static checks passed");
