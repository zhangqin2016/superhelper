#!/usr/bin/env node
// Mobile attachment materialization: decode/validate (pure) + write-to-temp
// (injected fs). Phone-sent base64 images become local temp-file paths the turn
// can read. Bounded + fail-open.

import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { decodeAttachment, materializeMobileAttachments, MAX_FILES, MAX_BYTES } = require("../src/main/mobile-attachments.js");

const b64 = (s) => Buffer.from(s).toString("base64");

// --- decode/validate ---
{
  const ok = decodeAttachment({ name: "shot.jpg", mimeType: "image/jpeg", dataBase64: b64("hello") });
  assert.ok(ok && Buffer.isBuffer(ok.buffer), "valid image decodes");
  assert.equal(ok.buffer.toString(), "hello");
  assert.equal(ok.name, "shot.jpg");

  // strips a data: URL prefix
  const withPrefix = decodeAttachment({ name: "a.png", mimeType: "image/png", dataBase64: `data:image/png;base64,${b64("x")}` });
  assert.ok(withPrefix, "data: URL prefix is stripped");

  // unknown/unsafe mime rejected
  assert.equal(decodeAttachment({ name: "x.exe", mimeType: "application/x-msdownload", dataBase64: b64("x") }), null, "unsafe type rejected");
  // empty / junk
  assert.equal(decodeAttachment({ mimeType: "image/png", dataBase64: "" }), null);
  assert.equal(decodeAttachment(null), null);
  // oversized rejected
  const big = "a".repeat(MAX_BYTES + 10);
  assert.equal(decodeAttachment({ name: "big.jpg", mimeType: "image/jpeg", dataBase64: b64(big) }), null, "oversized rejected");
  // filename sanitized + extension appended
  const dirty = decodeAttachment({ name: "../../etc/passwd", mimeType: "image/png", dataBase64: b64("x") });
  assert.ok(!dirty.name.includes("/") && dirty.name.endsWith(".png"), "path chars stripped, ext ensured");
}

// --- materialize with injected fs ---
{
  const written = [];
  const deps = {
    tmpDir: "/tmp/mc", stamp: "S",
    mkdirSync: () => {},
    writeFileSync: (p, buf) => written.push({ p, len: buf.length }),
    join: (d, n) => `${d}/${n}`,
  };
  const files = materializeMobileAttachments([
    { name: "a.jpg", mimeType: "image/jpeg", dataBase64: b64("aaa") },
    { name: "b.png", mimeType: "image/png", dataBase64: b64("bb") },
    { name: "bad", mimeType: "application/zip", dataBase64: b64("z") }, // skipped
  ], deps);
  assert.equal(files.length, 2, "only valid attachments materialize");
  assert.equal(files[0].path, "/tmp/mc/mcmd_S_0_a.jpg");
  assert.equal(files[0].name, "a.jpg");
  assert.equal(written.length, 2, "wrote two files");

  // count cap
  const many = Array.from({ length: MAX_FILES + 3 }, (_, i) => ({ name: `f${i}.png`, mimeType: "image/png", dataBase64: b64("x") }));
  assert.equal(materializeMobileAttachments(many, deps).length, MAX_FILES, "capped at MAX_FILES");

  // fail-open: a write throw skips that file, never throws
  const flaky = materializeMobileAttachments(
    [{ name: "a.jpg", mimeType: "image/jpeg", dataBase64: b64("a") }],
    { ...deps, writeFileSync: () => { throw new Error("disk full"); } },
  );
  assert.deepEqual(flaky, [], "write failure => empty, no throw");

  // no tmpDir => empty
  assert.deepEqual(materializeMobileAttachments([{ name: "a.jpg", mimeType: "image/jpeg", dataBase64: b64("a") }], { stamp: "S" }), []);
  assert.deepEqual(materializeMobileAttachments([], deps), []);
}

console.log("mobile-attachments: ok");
