import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
let createTransferManifestStore;
try { ({ createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest")); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
function fixture(t) {
  assert.equal(typeof createTransferManifestStore, "function", "recoverable transfers need an owned encrypted manifest store");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-transfer-manifest-")));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keyring"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text), decryptString: (bytes) => bytes.toString() } });
  const options = { rootPath: path.join(dir, "collaboration-transfer"), accountId: "alice", keyring };
  return { dir, options, store: createTransferManifestStore(options) };
}
const identity = { scopeId: "team:org", conversationId: "conversation", direction: "upload", purpose: "attachment" };

test("encrypted manifest survives restart with the same command IDs and revision", (t) => {
  const f = fixture(t), first = f.store.create(identity);
  assert.equal(first.revision, 1);
  const updated = f.store.update({ id: first.id, expectedRevision: 1, checkpoint: { state: "uploading", objectId: "obj", completedParts: [{ number: 1, etag: "opaque" }] } });
  const reopened = createTransferManifestStore(f.options);
  assert.deepEqual(reopened.read(first.id), updated);
  assert.deepEqual(updated.commandIds, first.commandIds);
  assert.equal(updated.revision, 2);
  assert.throws(() => reopened.update({ id: first.id, expectedRevision: 1, checkpoint: {} }), { code: "COLLAB_TRANSFER_CONFLICT" });
  const manifest = fs.readFileSync(path.join(f.store.directory(first.id), "manifest.json"), "utf8");
  for (const value of ["conversation", "uploading", "opaque"]) assert.equal(manifest.includes(value), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.store.directory(first.id)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.store.directory(first.id), "manifest.json")).mode & 0o777, 0o600);
  }
});

test("other account cannot read or clean a transfer by guessing its ID", (t) => {
  const f = fixture(t), item = f.store.create(identity);
  const other = createTransferManifestStore({ ...f.options, accountId: "bob" });
  assert.throws(() => other.read(item.id), { code: "COLLAB_TRANSFER_UNAVAILABLE" });
  assert.throws(() => other.remove(item.id), { code: "COLLAB_TRANSFER_UNAVAILABLE" });
  assert.deepEqual(f.store.read(item.id), item);
});

test("tampered or copied manifests remain on disk and are reported by recovery", (t) => {
  const f = fixture(t), a = f.store.create(identity), b = f.store.create(identity);
  fs.copyFileSync(path.join(f.store.directory(a.id), "manifest.json"), path.join(f.store.directory(b.id), "manifest.json"));
  assert.throws(() => f.store.read(b.id), { code: "COLLAB_TRANSFER_UNAVAILABLE" });
  assert.throws(() => f.store.remove(b.id), { code: "COLLAB_TRANSFER_UNAVAILABLE" });
  const recovered = f.store.scan();
  assert.deepEqual(recovered.transfers.map((item) => item.id), [a.id]);
  assert.equal(recovered.unrecognized.length, 1);
  assert.ok(fs.existsSync(path.join(f.store.directory(a.id), "manifest.json")));
});

test("cleanup never follows symlinks or deletes unknown files", (t) => {
  const f = fixture(t), item = f.store.create(identity), dir = f.store.directory(item.id);
  const outside = path.join(f.dir, "must-remain.txt"); fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, path.join(dir, "ciphertext.part"));
  assert.throws(() => f.store.remove(item.id), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  fs.unlinkSync(path.join(dir, "ciphertext.part"));
  fs.writeFileSync(path.join(dir, "unrecognized.txt"), "keep too");
  assert.throws(() => f.store.remove(item.id), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
  fs.unlinkSync(path.join(dir, "unrecognized.txt"));
  fs.writeFileSync(path.join(dir, "ciphertext.part"), "owned partial");
  assert.deepEqual(f.store.remove(item.id), { removed: true });
  assert.equal(fs.existsSync(dir), false);
});

test("root aliases, traversal IDs, symlink directories and root replacement fail closed", (t) => {
  const f = fixture(t), item = f.store.create(identity);
  for (const rootPath of [f.dir, `${f.dir}/../${path.basename(f.dir)}/collaboration-transfer`, "relative/collaboration-transfer"]) assert.throws(() => createTransferManifestStore({ ...f.options, rootPath }), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
  for (const id of ["..", "../outside", "", `${item.id}/x`]) assert.throws(() => f.store.read(id), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
  const savedRoot = `${f.options.rootPath}-original`;
  fs.renameSync(f.options.rootPath, savedRoot);
  fs.symlinkSync(savedRoot, f.options.rootPath);
  assert.throws(() => f.store.read(item.id), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
  assert.throws(() => f.store.scan(), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
});

test("oversized checkpoints and persisted network capabilities are rejected without replacing manifest", (t) => {
  const f = fixture(t), item = f.store.create(identity);
  for (const checkpoint of [{ token: "secret" }, { nested: { signedUrl: "https://private.invalid" } }, { data: "x".repeat(128 * 1024) }, { scopeId: "personal" },
    { downloadUri: "https://private.invalid/?auth=secret" }, { endpoint: "https://private.invalid" }, { response: ["https://private.invalid"] },
    { state: "https://private.invalid" }, { completedParts: [{ number: 1, etag: "https://private.invalid" }] }]) {
    assert.throws(() => f.store.update({ id: item.id, expectedRevision: 1, checkpoint }), { code: "COLLAB_TRANSFER_MANIFEST_INVALID" });
    assert.deepEqual(f.store.read(item.id), item);
  }
});

test("scope-key revocation prevents recovery or destructive cleanup", (t) => {
  const f = fixture(t), item = f.store.create(identity), folder = f.store.directory(item.id);
  f.options.keyring.destroyScopeKey({ accountId: "alice", scopeId: "team:org" });
  assert.throws(() => f.store.read(item.id), { code: "COLLAB_TRANSFER_UNAVAILABLE" });
  assert.throws(() => f.store.remove(item.id), { code: "COLLAB_TRANSFER_UNAVAILABLE" });
  assert.equal(f.store.scan().unrecognized.length, 1);
  assert.ok(fs.existsSync(folder), "unrecoverable ownership is preserved for explicit handling");
});

test("a FIFO masquerading as a manifest cannot hang main-process recovery", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t), item = f.store.create(identity), filename = path.join(f.store.directory(item.id), "manifest.json");
  fs.unlinkSync(filename);
  const fifo = spawnSync("mkfifo", [filename], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  const modulePath = require.resolve("../src/main/collaboration/transfer-manifest");
  const source = `const {createTransferManifestStore}=require(${JSON.stringify(modulePath)});const store=createTransferManifestStore({rootPath:${JSON.stringify(f.options.rootPath)},accountId:'alice',keyring:{encrypt(){},decrypt(){}}});try{store.read(${JSON.stringify(item.id)});process.exit(1)}catch(error){process.exit(error.code==='COLLAB_TRANSFER_UNAVAILABLE'?0:2)}`;
  const child = spawnSync(process.execPath, ["-e", source], { timeout: 1500, encoding: "utf8" });
  assert.equal(child.status, 0, `non-regular manifests must be rejected before blocking open: ${child.error?.code || child.stderr}`);
});

test("create flushes every new directory entry as well as the manifest rename", { skip: process.platform === "win32" }, (t) => {
  const original = fs.fsyncSync, flushed = [];
  fs.fsyncSync = (fd) => { const stat = fs.fstatSync(fd); if (stat.isDirectory()) flushed.push(`${stat.dev}:${stat.ino}`); return original(fd); };
  try {
    const f = fixture(t), item = f.store.create(identity), folder = f.store.directory(item.id);
    for (const directory of [f.dir, f.options.rootPath, path.dirname(folder), folder]) {
      const stat = fs.statSync(directory);
      assert.ok(flushed.includes(`${stat.dev}:${stat.ino}`), "successful create must persist all parent directory entries, not only file bytes");
    }
  } finally { fs.fsyncSync = original; }
});

test("hardlinked manifests or payloads are preserved rather than authenticated for cleanup", (t) => {
  const f = fixture(t), item = f.store.create(identity), folder = f.store.directory(item.id);
  const externalManifest = path.join(f.dir, "manifest-copy");
  fs.linkSync(path.join(folder, "manifest.json"), externalManifest);
  assert.throws(() => f.store.remove(item.id), { code: "COLLAB_TRANSFER_UNAVAILABLE" });
  assert.ok(fs.existsSync(externalManifest)); fs.unlinkSync(externalManifest);
  const externalPayload = path.join(f.dir, "payload"); fs.writeFileSync(externalPayload, "preserve");
  fs.linkSync(externalPayload, path.join(folder, "ciphertext.part"));
  assert.throws(() => f.store.remove(item.id), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
  assert.deepEqual(f.store.read(item.id), item);
  assert.equal(fs.readFileSync(externalPayload, "utf8"), "preserve");
});

test("failed manifest rename retains the previous recoverable checkpoint", (t) => {
  const f = fixture(t), item = f.store.create(identity), original = fs.renameSync;
  fs.renameSync = (source, target) => { if (path.basename(target) === "manifest.json") throw Object.assign(new Error("injected disk error"), { code: "EIO" }); return original(source, target); };
  try { assert.throws(() => f.store.update({ id: item.id, expectedRevision: 1, checkpoint: { state: "uploading" } }), { code: "EIO" }); }
  finally { fs.renameSync = original; }
  assert.deepEqual(createTransferManifestStore(f.options).read(item.id), item);
  assert.deepEqual(fs.readdirSync(f.store.directory(item.id)), ["manifest.json"]);
});
