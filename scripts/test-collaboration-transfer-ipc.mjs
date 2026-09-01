import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createCollaborationIpc } from "../src/main/ipc-collaboration.js";

const commands = [
  ["get-transfers", "getTransfers", {}],
  ["prepare-attachment", "prepareAttachment", { conversationId: "conversation" }],
  ["enqueue-transfer", "enqueueTransfer", { transferId: "transfer" }],
  ["pause-transfer", "pauseTransfer", { transferId: "transfer" }],
  ["cancel-transfer", "cancelTransfer", { transferId: "transfer" }],
  ["prepare-download", "prepareDownload", { conversationId: "conversation", messageId: "message", objectId: "object" }],
  ["save-download", "saveDownload", { transferId: "transfer" }],
  ["send-attachments", "sendAttachments", { conversationId: "conversation", transferIds: ["transfer-a", "transfer-b"], bodyText: "attachment body", clientCommandId: "stable-command" }],
];
function fixture(result) {
  const calls = [], handlers = new Map();
  const service = { ok: true };
  for (const [, method] of commands) service[method] = (payload) => { calls.push([method, payload]); return result; };
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
  return { calls, invoke: (channel, payload) => handlers.get(`collaboration:${channel}`)(null, payload) };
}
test("all transfer commands reject renderer authority and malformed IDs before dispatch", async () => {
  const f = fixture({ ok: true });
  for (const [channel, method, payload] of commands) {
    const invalid = [null, [], "transfer", { ...payload, accountId: "other" }, { ...payload, scopeId: "personal" },
      { ...payload, inputPath: "/private/source" }, { ...payload, destinationPath: "/private/destination" }, { ...payload, dek: "secret" }];
    if (channel === "send-attachments") {
      invalid.push(
        { ...payload, conversationId: "" }, { ...payload, transferIds: [] }, { ...payload, transferIds: ["transfer-a", "transfer-a"] },
        { ...payload, transferIds: ["../secret"] }, { ...payload, bodyText: 123 }, { ...payload, bodyText: "x".repeat(32 * 1024 + 1) },
        { ...payload, clientCommandId: "../secret" },
      );
    } else {
      for (const key of Object.keys(payload)) for (const value of ["", "../secret", "a".repeat(201), {}, 123]) invalid.push({ ...payload, [key]: value });
    }
    for (const input of invalid) assert.equal((await f.invoke(channel, input)).code, "COLLABORATION_INVALID_INPUT", channel);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.invoke(channel, payload)).ok, true);
    assert.deepEqual(f.calls.pop(), [method, payload]);
  }
});
test("transfer result projection excludes credentials, paths and unrecognized metadata", async () => {
  const raw = { ok: true, id: "transfer", state: "ready", originalName: "result.txt", bytes: 12,
    sourcePath: "/private/file", destinationPath: "/private/save", dek: "secret", signedUrl: "https://secret.invalid",
    checkpoint: { content: { dek: "secret" } }, message: "secret", code: "EIO /private/file" };
  for (const [channel] of commands.slice(1)) assert.deepEqual(await fixture(raw).invoke(channel, commands.find(([name]) => name === channel)[2]),
    { ok: true, id: "transfer", state: "ready", originalName: "result.txt", bytes: 12 });
  const listed = await fixture({ ok: true, transfers: [raw], unrecognizedCount: 2, recoveryFailureCount: 1, rootPath: "/private" }).invoke("get-transfers", {});
  assert.equal(listed.unrecognizedCount, 2);
  assert.equal(listed.recoveryFailureCount, 1, "renderer receives only the aggregate durable recovery-failure signal");
  assert.doesNotMatch(JSON.stringify(listed), /secret|private|signedUrl|checkpoint|sourcePath/);
  const failedSend = await fixture({ ok: true, id: "transfer", clientCommandId: "command", state: "verified", sendState: "failed", encryptedPath: "/private" })
    .invoke("get-transfers", {});
  assert.deepEqual(failedSend, { ok: true, transfers: [], unrecognizedCount: 0, recoveryFailureCount: 0 }, "direct get-transfers only accepts list envelopes");
  const failedSendList = await fixture({ ok: true, transfers: [{ id: "transfer", clientCommandId: "command", state: "verified", sendState: "failed", encryptedPath: "/private" }] })
    .invoke("get-transfers", {});
  assert.deepEqual(failedSendList.transfers[0], { ok: true, id: "transfer", clientCommandId: "command", state: "verified", sendState: "failed" }, "terminal text-outbox failures remain visible beside a verified attachment without exposing encrypted paths");
});
test("actual preload exposes only transfer ID commands, never the verified file broker", async () => {
  const source = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
  const block = source.match(/collaboration:\s*\{([\s\S]*?)\n\s*\},\n\s*onRuntimeEvents/)[1];
  const calls = [];
  const bridge = vm.runInNewContext(`({${block}})`, { ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } });
  assert.equal(bridge.verifiedFile, undefined);
  await bridge.getTransfers({ accountId: "other" });
  await bridge.prepareAttachment("conversation", "/private/file");
  await bridge.enqueueTransfer("transfer"); await bridge.pauseTransfer("transfer"); await bridge.cancelTransfer("transfer");
  await bridge.prepareDownload({ conversationId: "conversation", messageId: "message", objectId: "object", path: "/private/file", dek: "secret" });
  await bridge.saveDownload("transfer", "/private/save");
  await bridge.sendAttachments({ conversationId: "conversation", transferIds: ["transfer-a", "transfer-b"], bodyText: "attachment body", clientCommandId: "stable-command", objectId: "forged", sourcePath: "/private/file" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), commands.map(([channel, , payload]) =>
    channel === "get-transfers" ? [`collaboration:${channel}`] : [`collaboration:${channel}`, payload]));
});
