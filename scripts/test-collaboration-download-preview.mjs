import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { transferResult } = require("../src/main/collaboration/transfer-ipc");
let createTransferManager;
try { ({ createTransferManager } = require("../src/main/collaboration/transfer-manager")); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

test("download preview resolves only ready downloads under authorization", async (t) => {
  assert.equal(typeof createTransferManager, "function", "a recoverable main-only transfer manager is required");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-preview-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const manifests = createTransferManifestStore({ rootPath: path.join(dir, "collaboration-transfer"), accountId: "alice", keyring });
  let authorized = true;
  const manager = createTransferManager({ manifests, objectClient: { downloadTicket: async () => { throw Object.assign(new Error("no network"), { code: "NO_NETWORK" }); } }, multipart: {}, deviceId: "device", assertAuthorized: () => authorized });

  const download = manifests.create({ scopeId: "personal", conversationId: "conversation", direction: "download", purpose: "attachment" });
  const ready = { state: "ready", objectId: "object-1", content: { dek: Buffer.alloc(32).toString("base64"), originalName: "photo.png", mimeType: "image/png", ciphertextSize: 1, ciphertextSha256: "a".repeat(64) }, plaintext: { size: 1, sha256: "b".repeat(64), originalName: "photo.png" } };
  manifests.update({ id: download.id, expectedRevision: download.revision, checkpoint: ready });
  fs.writeFileSync(path.join(manifests.directory(download.id), "plaintext.verified"), "x");

  const resolved = manager.plaintextFile(download.id);
  assert.equal(resolved.ok, true);
  assert.ok(resolved.path.endsWith("plaintext.verified"), "plaintext path must point at the verified file");
  assert.equal(resolved.mimeType, "image/png");
  assert.equal(resolved.originalName, "photo.png");

  const denied = (() => { try { authorized = false; return manager.plaintextFile(download.id); } catch (error) { return { error: error.code }; } })();
  assert.ok(denied.error, "revoked scope must refuse the plaintext path");
  authorized = true;

  const pending = manifests.create({ scopeId: "personal", conversationId: "conversation", direction: "download", purpose: "attachment" });
  manifests.update({ id: pending.id, expectedRevision: pending.revision, checkpoint: { state: "downloading", objectId: "object-2" } });
  assert.throws(() => manager.plaintextFile(pending.id), (error) => error.code === "COLLAB_TRANSFER_NOT_READY");

  const upload = manifests.create({ scopeId: "personal", conversationId: "conversation", direction: "upload", purpose: "attachment" });
  manifests.update({ id: upload.id, expectedRevision: upload.revision, checkpoint: { state: "ready", objectId: "object-3", plaintext: { size: 1, sha256: "c".repeat(64), originalName: "up.png" } } });
  assert.throws(() => manager.plaintextFile(upload.id), (error) => error.code === "COLLAB_TRANSFER_DEVICE_CHANGED" || error.code === "COLLAB_TRANSFER_NOT_READY");

  const view = transferResult("previewDownload", resolved, { toPreviewUrl: (p) => `app-file://media/${encodeURIComponent(p)}` });
  assert.equal(view.ok, true);
  assert.ok(view.url.startsWith("app-file://"), "renderer receives an app-file URL");
  assert.ok(!JSON.stringify(view).includes(dir), "absolute disk path must never reach the renderer");
  assert.equal(view.mimeType, "image/png");
});
