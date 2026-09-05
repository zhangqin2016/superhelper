import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { encryptFile } = require("../src/main/collaboration/encrypted-container");
let createTransferRuntime;
try { ({ createTransferRuntime } = require("../src/main/collaboration/transfer-runtime")); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

function fixture(t) {
  assert.equal(typeof createTransferRuntime, "function", "main-owned policy, scope and native file grants must be connected");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-transfer-runtime-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } });
  const store = new CollaborationStore({ dbPath: path.join(dir, "collaboration.db"), accountId: "alice", keyring });
  t.after(() => store.close());
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "conversation", kind: "direct" }] });
  const source = path.join(dir, "private-result.txt"); fs.writeFileSync(source, "local work");
  const state = { selections: 0, requests: 0, active: true };
  const options = { store, deviceId: "device", rootPath: path.join(dir, "collaboration-transfer"),
    policy: { enabled: true, attachments: true, workspaceShares: false },
    assertActive: () => { if (!state.active) throw Object.assign(new Error("stopped"), { code: "COLLABORATION_STOPPED" }); },
    chooseFile: async () => { state.selections++; return { canceled: false, filePaths: [source] }; },
    client: { objects: { async init() { state.requests++; throw Object.assign(new Error("secret URL"), { code: "COLLAB_RESPONSE_UNKNOWN", retryable: true }); } } },
  };
  const create = (overrides = {}) => { const runtime = createTransferRuntime({ ...options, ...overrides }); t.after(() => runtime.stop?.()); return runtime; };
  return { dir, store, source, state, options, create };
}

test("disabled attachment policy touches no transfer root or native picker", (t) => {
  const f = fixture(t), runtime = f.create({ policy: { enabled: false, attachments: true } });
  assert.equal(runtime.ok, false); assert.equal(f.state.selections, 0); assert.equal(f.state.requests, 0);
  assert.equal(fs.existsSync(f.options.rootPath), false);
  assert.ok(f.store.getConversation({ conversationId: "conversation" }), "text collaboration remains available");
});

test("native selection stages encrypted data without uploading or exposing paths", async (t) => {
  const f = fixture(t), runtime = f.create();
  const prepared = await runtime.prepareAttachment({ conversationId: "conversation" });
  assert.equal(prepared.ok, true); assert.equal(prepared.state, "prepared");
  assert.equal(f.state.selections, 1); assert.equal(f.state.requests, 0);
  assert.doesNotMatch(JSON.stringify(prepared), /inputPath|dek|ciphertextSha256/);
  assert.ok(!JSON.stringify(prepared).includes(f.dir));
  assert.equal((await runtime.prepareAttachment({ conversationId: "conversation", inputPath: f.source })).code, "COLLABORATION_INVALID_INPUT");
  assert.equal(f.state.selections, 1, "renderer paths are not an alternative file grant");
  assert.equal(runtime.list().transfers[0].id, prepared.id);
});

test("account stop while the native picker is open cannot stage or reveal the old selection", async (t) => {
  const f = fixture(t);
  let release;
  const runtime = f.create({ chooseFile: () => new Promise((resolve) => { release = resolve; }) });
  const pending = runtime.prepareAttachment({ conversationId: "conversation" });
  runtime.stop(); release({ canceled: false, filePaths: [f.source] });
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.code, "COLLABORATION_STOPPED");
  assert.deepEqual(runtime.list().transfers, []); assert.equal(f.state.requests, 0);
});

test("only authorized message-bound object references can prepare a download", async (t) => {
  const f = fixture(t), runtime = f.create();
  f.store.hydrateAuthorizedHistory({ conversationId: "conversation", messages: [{ id: "message", createSeq: 1, kind: "attachment", attachmentIds: ["object"], revision: 1 }] });
  assert.equal((await runtime.prepareDownload({ conversationId: "conversation", messageId: "message", objectId: "other" })).ok, false);
  const prepared = await runtime.prepareDownload({ conversationId: "conversation", messageId: "message", objectId: "object" });
  assert.equal(prepared.ok, true); assert.equal(prepared.direction, "download");
  assert.equal((await runtime.prepareDownload({ conversationId: "conversation", messageId: "message", objectId: "object" })).id, prepared.id, "repeated download clicks reuse durable progress");
  f.store.hydrateAuthorizedHistory({ conversationId: "conversation", messages: [{ id: "message", createSeq: 1, kind: "attachment", attachmentIds: ["object"], revision: 2, revokedAt: "2026-08-31T00:00:00Z" }] });
  assert.equal((await runtime.prepareDownload({ conversationId: "conversation", messageId: "message", objectId: "object" })).ok, false);
});

test("publishing a verified cached download requires fresh server authorization", async (t) => {
  const f = fixture(t), key = crypto.randomBytes(32), ciphertextPath = path.join(f.dir, "fixture.lilyenc");
  const encrypted = await encryptFile({ inputPath: f.source, outputPath: ciphertextPath, key });
  const ciphertext = fs.readFileSync(ciphertextPath);
  let tickets = 0, permitted = true;
  f.options.client.objects.downloadTicket = async () => {
    tickets++;
    if (!permitted) throw Object.assign(new Error("revoked"), { code: "COLLAB_OBJECT_UNAVAILABLE" });
    return { objectId: "object", url: "https://private.invalid/object", dek: key.toString("base64"),
      ciphertextSize: ciphertext.length, ciphertextSha256: encrypted.ciphertextSha256, expiresAt: new Date(Date.now() + 300000).toISOString() };
  };
  const destination = path.join(f.dir, "saved-result.txt");
  const runtime = f.create({ chooseSaveFile: async ({ defaultName }) => {
    assert.equal(defaultName, path.basename(f.source)); return { canceled: false, filePath: destination };
  }, fetchImpl: async () => new Response(ciphertext, { status: 206, headers: { "content-range": `bytes 0-${ciphertext.length - 1}/${ciphertext.length}` } }) });
  f.store.hydrateAuthorizedHistory({ conversationId: "conversation", messages: [{ id: "message", createSeq: 1, kind: "attachment", attachmentIds: ["object"], revision: 1 }] });
  const item = await runtime.prepareDownload({ conversationId: "conversation", messageId: "message", objectId: "object" });
  await runtime.enqueue({ transferId: item.id });
  const deadline = Date.now() + 5000;
  while (runtime.list().transfers[0]?.state !== "ready" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.list().transfers[0]?.state, "ready");
  const before = tickets;
  await runtime.verifiedFile(item.id);
  assert.ok(tickets > before, "a cached plaintext path is not a permanent server authorization grant");
  assert.equal(typeof runtime.saveDownload, "function", "a native save broker must publish verified results");
  const saved = await runtime.saveDownload({ transferId: item.id });
  assert.equal(saved.saved, true); assert.equal(fs.readFileSync(destination, "utf8"), "local work");
  assert.ok(!JSON.stringify(saved).includes(f.dir));
  assert.equal((await runtime.saveDownload({ transferId: item.id })).code, "COLLAB_TRANSFER_DESTINATION_EXISTS");
  assert.equal((await runtime.saveDownload({ transferId: item.id, destinationPath: destination })).code, "COLLABORATION_INVALID_INPUT");
  permitted = false;
  await assert.rejects(runtime.verifiedFile(item.id), { code: "COLLAB_OBJECT_UNAVAILABLE" });
});

test("a conversation removed while selecting a file cannot acquire a new local scope key", async (t) => {
  const f = fixture(t);
  const runtime = f.create({ chooseFile: async () => {
    f.store.replaceProjectionFromBootstrap({ conversations: [] });
    return { canceled: false, filePaths: [f.source] };
  } });
  const result = await runtime.prepareAttachment({ conversationId: "conversation" });
  assert.equal(result.code, "COLLAB_ACCESS_REVOKED"); assert.equal(f.state.requests, 0);
  assert.deepEqual(runtime.list().transfers, []);
});

test("disabling one transfer purpose prevents its persisted jobs from resuming under another enabled purpose", async (t) => {
  const f = fixture(t), first = f.create();
  const item = await first.prepareAttachment({ conversationId: "conversation" });
  await first.enqueue({ transferId: item.id });
  first.stop();
  const before = f.state.requests;
  const next = f.create({ policy: { enabled: true, attachments: false, workspaceShares: true } });
  next.start(); await new Promise(setImmediate);
  assert.equal(next.list().transfers.length, 0);
  assert.equal((await next.enqueue({ transferId: item.id })).ok, false);
  assert.equal(f.state.requests, before);
});

test("a cancelled native picker creates no transfer or network request", async (t) => {
  const f = fixture(t), runtime = f.create({ chooseFile: async () => ({ canceled: true, filePaths: [] }) });
  assert.deepEqual(await runtime.prepareAttachment({ conversationId: "conversation" }), { ok: true, cancelled: true });
  assert.deepEqual(runtime.list().transfers, []); assert.equal(f.state.requests, 0);
});

test("drop and clipboard import prepare encrypted attachments without network and enforce account access", async (t) => {
  const f = fixture(t), runtime = f.create();
  const dropped = await runtime.importAttachment({conversationId:"conversation",source:{kind:"file",path:f.source}});
  assert.equal(dropped.ok,true);assert.equal(dropped.state,"prepared");
  const pasted = await runtime.importAttachment({conversationId:"conversation",source:{kind:"image",bytes:Buffer.from('89504e470d0a1a0a00000000','hex')}});
  assert.equal(pasted.ok,true);assert.match(pasted.originalName,/\.png$/);assert.equal(pasted.state,"prepared");
  assert.equal(f.state.requests,0);assert.equal(f.state.selections,0);
  assert.deepEqual(fs.readdirSync(path.join(f.options.rootPath,'imports')),[]);
  assert.equal((await runtime.importAttachment({conversationId:"missing",source:{kind:"file",path:f.source}})).ok,false);
  runtime.stop();assert.equal((await runtime.importAttachment({conversationId:"conversation",source:{kind:"file",path:f.source}})).ok,false);
});
