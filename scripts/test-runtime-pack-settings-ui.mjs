#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const html = read("src/renderer/index.html");
assert.match(html, /data-settings-page="runtime"/, "settings nav must expose the Runtime page");
assert.match(html, /id="runtimePackList"/, "Runtime page must include the pack list mount");

const settingsPanel = read("src/renderer/modules/settings-panel.js");
assert.match(settingsPanel, /"runtime"/, "settings page allowlist must include runtime");
assert.match(settingsPanel, /refreshRuntimePackSettings/, "settings refresh must include runtime packs");
assert.match(settingsPanel, /initRuntimePackSettings/, "settings init must wire runtime pack actions");

const preload = read("src/preload.js");
assert.match(preload, /listRuntimePacks/, "preload must expose runtime pack list");
assert.match(preload, /installRuntimePack/, "preload must expose runtime pack install");
assert.match(preload, /uninstallRuntimePack/, "preload must expose runtime pack uninstall");
assert.match(preload, /onRuntimePackProgress/, "preload must expose runtime pack progress events");

const ipc = read("src/main/ipc-handlers.js");
assert.match(ipc, /registerRuntimePackHandlers/, "main IPC registration must include runtime packs");

assert(fs.existsSync(path.join(ROOT, "src/renderer/modules/runtime-pack-settings.js")), "renderer runtime-pack settings module must exist");
assert(fs.existsSync(path.join(ROOT, "src/main/ipc-runtime-packs.js")), "main runtime-pack IPC module must exist");

const runtimePackSettings = read("src/renderer/modules/runtime-pack-settings.js");
assert.match(runtimePackSettings, /settings\.runtime\.status\.bundled/, "runtime UI must label bundled packs distinctly");
assert.match(runtimePackSettings, /!pack\.readOnly/, "runtime UI must not offer uninstall for read-only bundled packs");

console.log("runtime-pack-settings-ui: ok");
