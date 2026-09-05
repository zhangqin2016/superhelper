import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
const block = source.match(/collaboration:\s*\{([\s\S]*?)\n\s*\},\n\s*onRuntimeEvents/);
assert.ok(block, "preload exposes a bounded collaboration bridge before event subscriptions");
for (const name of ["getState", "bootstrap", "list", "open", "send", "sendAttachments", "retry", "cancel", "markRead"]) {
  assert.match(block[1], new RegExp(`\\b${name}\\b`), `preload exposes ${name}`);
}
assert.match(block[1], /onStateChange/, "preload exposes a collaboration state subscription");
assert.match(block[1], /collaboration:subscribe/, "subscription is explicitly registered in main");
assert.match(block[1], /collaboration:unsubscribe/, "subscription is explicitly removed in main");
assert.match(block[1], /removeListener/, "renderer receives an unsubscribe callback");
assert.doesNotMatch(block[1], /accessToken|wrappedDek|localPath|ipcRenderer\.send\(/, "bridge does not provide secret/path or generic send access");
assert.match(block[1], /collaboration:send/, "bridge uses the fixed collaboration IPC namespace");
assert.match(block[1], /webUtils\.getPathForFile\(file\)/, "drop import resolves an OS-backed File inside preload");
assert.doesNotMatch(block[1], /prepareDroppedAttachment:\s*\([^)]*(?:filePath|path)/, "drop API accepts a File, never a renderer path");
const calls = [];
const bridge = vm.runInNewContext(`({${block[1]}})`, { ipcRenderer: { invoke: (...args) => calls.push(args) } });
bridge.send({ conversationId: "c", clientCommandId: "cmd", bodyText: "body", replyToMessageId: "reply", mentionUserIds: ["bob"], senderUserId: "forged" });
bridge.saveDraft({ conversationId: "c", text: "body", replyToMessageId: "reply", mentionUserIds: ["bob"], senderUserId: "forged" });
assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
  ["collaboration:send", { conversationId: "c", clientCommandId: "cmd", bodyText: "body", replyToMessageId: "reply", mentionUserIds: ["bob"] }],
  ["collaboration:save-draft", { conversationId: "c", text: "body", replyToMessageId: "reply", mentionUserIds: ["bob"] }],
], "preload forwards complete explicit intent through its closed field vocabulary");

console.log("collaboration preload checks passed");
