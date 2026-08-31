import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let saveVerifiedDownload;
try { ({ saveVerifiedDownload } = require("../src/main/collaboration/save-transfer")); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
function fixture(t) {
  assert.equal(typeof saveVerifiedDownload, "function", "verified downloads require an atomic main-owned save broker");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-save-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, "source"), destinationPath = path.join(dir, "chosen.txt");
  const bytes = Buffer.alloc(128 * 1024 + 7, 42); fs.writeFileSync(sourcePath, bytes);
  const options = { sourcePath, destinationPath, expectedSize: bytes.length, expectedSha256: crypto.createHash("sha256").update(bytes).digest("hex"), assertAuthorized: () => {}, beforePublish: async () => {} };
  return { dir, bytes, options };
}
test("verified bytes publish exclusively and leave no temporary plaintext", async (t) => {
  const f = fixture(t), result = await saveVerifiedDownload(f.options);
  assert.deepEqual(fs.readFileSync(f.options.destinationPath), f.bytes);
  assert.deepEqual(result, { ok: true, saved: true, bytes: f.bytes.length });
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ["chosen.txt", "source"]);
});
test("an existing user file is never replaced", async (t) => {
  const f = fixture(t); fs.writeFileSync(f.options.destinationPath, "original");
  await assert.rejects(saveVerifiedDownload(f.options), { code: "EEXIST" });
  assert.equal(fs.readFileSync(f.options.destinationPath, "utf8"), "original");
});
test("wrong plaintext hash leaves no output and cleans only the owned temporary file", async (t) => {
  const f = fixture(t); f.options.expectedSha256 = "0".repeat(64);
  await assert.rejects(saveVerifiedDownload(f.options), { code: "COLLAB_TRANSFER_INTEGRITY_FAILED" });
  assert.deepEqual(fs.readdirSync(f.dir), ["source"]);
});
test("revocation at final authorization prevents publication after copying", async (t) => {
  const f = fixture(t); let final = false;
  f.options.beforePublish = async () => { final = true; throw Object.assign(new Error("revoked"), { code: "COLLAB_ACCESS_REVOKED" }); };
  await assert.rejects(saveVerifiedDownload(f.options), { code: "COLLAB_ACCESS_REVOKED" });
  assert.equal(final, true); assert.deepEqual(fs.readdirSync(f.dir), ["source"]);
});
test("another file appearing during save is preserved by atomic exclusive publication", async (t) => {
  const f = fixture(t); f.options.beforePublish = async () => { fs.writeFileSync(f.options.destinationPath, "other writer"); };
  await assert.rejects(saveVerifiedDownload(f.options), { code: "EEXIST" });
  assert.equal(fs.readFileSync(f.options.destinationPath, "utf8"), "other writer");
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ["chosen.txt", "source"]);
});
test("symlink and hardlinked source files are rejected", async (t) => {
  const f = fixture(t), linked = path.join(f.dir, "linked");
  fs.linkSync(f.options.sourcePath, linked);
  await assert.rejects(saveVerifiedDownload(f.options), { code: "COLLAB_TRANSFER_UNSAFE_PATH" });
  fs.unlinkSync(linked); fs.symlinkSync(f.options.sourcePath, linked);
  await assert.rejects(saveVerifiedDownload({ ...f.options, sourcePath: linked }), { code: "LILYENC_PATH_INVALID" });
  assert.equal(fs.existsSync(f.options.destinationPath), false);
});

test("revocation during the final async path check still prevents publication", async (t) => {
  const f = fixture(t), original = fs.promises.lstat;
  let authorized = true, final = false;
  f.options.assertAuthorized = () => authorized;
  f.options.beforePublish = async () => { final = true; };
  fs.promises.lstat = async (...args) => {
    if (final && args[0] === f.options.destinationPath) authorized = false;
    return original.apply(fs.promises, args);
  };
  try {
    await assert.rejects(saveVerifiedDownload(f.options), { code: "COLLAB_ACCESS_REVOKED" });
    assert.equal(fs.existsSync(f.options.destinationPath), false);
  } finally { fs.promises.lstat = original; }
});
