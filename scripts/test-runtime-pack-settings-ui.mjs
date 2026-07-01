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
assert.match(html, /data-settings-page="runtime"/, "settings nav must expose the dependency page");
assert.match(html, /id="runtimePackList"/, "dependency page must include the pack list mount");
assert.match(html, /id="runtimePacksHealthBtn"/, "dependency page must include a health check action");
assert.match(html, /data-i18n="settings\.nav\.runtime">依赖</, "dependency page fallback label must not say runtime");

const settingsPanel = read("src/renderer/modules/settings-panel.js");
assert.match(settingsPanel, /"runtime"/, "settings page allowlist must include the dependency page route");
assert.match(settingsPanel, /refreshRuntimePackSettings/, "settings refresh must include runtime packs");
assert.match(settingsPanel, /initRuntimePackSettings/, "settings init must wire runtime pack actions");

const preload = read("src/preload.js");
assert.match(preload, /listRuntimePacks/, "preload must expose runtime pack list");
assert.match(preload, /checkRuntimePackAvailability/, "preload must expose runtime pack availability preflight");
assert.match(preload, /checkRuntimePackHealth/, "preload must expose dependency health checks");
assert.match(preload, /installRuntimePack/, "preload must expose runtime pack install");
assert.match(preload, /uninstallRuntimePack/, "preload must expose runtime pack uninstall");
assert.match(preload, /onRuntimePackProgress/, "preload must expose runtime pack progress events");

const ipc = read("src/main/ipc-handlers.js");
assert.match(ipc, /registerRuntimePackHandlers/, "main IPC registration must include runtime packs");
const runtimePackIpc = read("src/main/ipc-runtime-packs.js");
assert.match(runtimePackIpc, /runtime-packs:availability/, "main IPC must expose runtime pack availability preflight");

assert(fs.existsSync(path.join(ROOT, "src/renderer/modules/runtime-pack-settings.js")), "renderer runtime-pack settings module must exist");
assert(fs.existsSync(path.join(ROOT, "src/main/ipc-runtime-packs.js")), "main runtime-pack IPC module must exist");

const runtimePackSettings = read("src/renderer/modules/runtime-pack-settings.js");
assert.match(runtimePackSettings, /settings\.runtime\.status\.bundled/, "runtime UI must label bundled packs distinctly");
assert.match(runtimePackSettings, /settings\.runtime\.status\.unavailable/, "runtime UI must label packs unavailable on this platform");
assert.match(runtimePackSettings, /checkRuntimePackAvailability/, "runtime UI must preflight server artifact availability");
assert.match(runtimePackSettings, /dataset\.unavailable/, "runtime UI must disable install for unavailable platform artifacts");
assert.match(runtimePackSettings, /settings\.runtime\.health\.ok/, "runtime UI must render dependency health state");
assert.match(runtimePackSettings, /!pack\.readOnly/, "runtime UI must not offer uninstall for read-only bundled packs");

const zh = JSON.parse(read("src/renderer/i18n/locales/zh-CN.json"));
assert.equal(zh["settings.nav.runtime"], "依赖", "runtime settings page should be user-facing Dependencies");
for (const key of ["document", "image", "browser", "media"]) {
  assert.equal(typeof zh[`settings.runtime.category.${key}`], "string", `missing dependency category ${key}`);
}
for (const key of ["check", "checking", "ok", "failed", "notInstalled", "allOk", "failedCount"]) {
  assert.equal(typeof zh[`settings.runtime.health.${key}`], "string", `missing dependency health label ${key}`);
}
assert.equal(typeof zh["settings.runtime.status.unavailable"], "string", "missing unavailable status label");
assert.equal(zh["settings.runtime.category.system"], undefined, "old system runtime category should not remain");
assert.equal(zh["settings.runtime.category.common"], undefined, "old common runtime category should not remain");

console.log("runtime-pack-settings-ui: ok");
