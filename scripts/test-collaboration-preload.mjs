import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
const block = source.match(/collaboration:\s*\{([\s\S]*?)\n\s*\},\n\s*onRuntimeEvents/);
assert.ok(block, "preload exposes a bounded collaboration bridge before event subscriptions");
for (const name of ["getState", "bootstrap", "list", "open", "send", "retry", "cancel", "markRead"]) {
  assert.match(block[1], new RegExp(`\\b${name}\\b`), `preload exposes ${name}`);
}
assert.match(block[1], /onStateChange/, "preload exposes a collaboration state subscription");
assert.match(block[1], /collaboration:subscribe/, "subscription is explicitly registered in main");
assert.match(block[1], /collaboration:unsubscribe/, "subscription is explicitly removed in main");
assert.match(block[1], /removeListener/, "renderer receives an unsubscribe callback");
assert.doesNotMatch(block[1], /accessToken|wrappedDek|localPath|filePath|ipcRenderer\.send\(/, "bridge does not provide secret/path or generic send access");
assert.match(block[1], /collaboration:send/, "bridge uses the fixed collaboration IPC namespace");

console.log("collaboration preload checks passed");
