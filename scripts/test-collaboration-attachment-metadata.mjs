#!/usr/bin/env node
/**
 * Attachment metadata across the three layers.
 *
 * The load-bearing rule: `attachmentIds` addresses and authorizes a download;
 * `attachments` only DESCRIBES. So metadata may never add an attachment, remove
 * one, reorder the id list, or survive a revocation — and when it is absent or
 * malformed the bubble must fall back to exactly the behaviour that shipped
 * before it existed (a download action), never to a broken or empty card.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const { attachmentMetadata, attachmentIds } = require("../src/main/collaboration/history-cache");
const { attachmentMetadataView } = await import(
  url.pathToFileURL(path.join(ROOT, "server/src/services/collaboration/message-history-view.js")).href
);

const ids = ["obj_a", "obj_b"];
const good = { objectId: "obj_a", originalName: "plan.png", mimeType: "image/png", sizeBytes: 2048 };

// ---- Both layers enforce the same rules, so they are checked together. -----
for (const [layer, view] of [
  ["server", (message) => attachmentMetadataView(message, attachmentIds(message), Boolean(message.revokedAt))],
  ["client", (message) => attachmentMetadata(message, attachmentIds(message))],
]) {
  const at = (label) => `${layer}: ${label}`;

  assert.deepEqual(view({ attachmentIds: ids, attachments: [good] }),
    [{ objectId: "obj_a", originalName: "plan.png", mimeType: "image/png", sizeBytes: 2048 }], at("a valid row passes through"));

  // A revoked message has already had its body blanked; a filename is content too.
  assert.deepEqual(view({ attachmentIds: ids, attachments: [good], revokedAt: "2026-01-01T00:00:00Z" }), [],
    at("a revoked message exposes no filename"));

  // Metadata for an object the id list does not contain would be an attachment
  // the viewer cannot address — and, worse, one authorization never saw.
  assert.deepEqual(view({ attachmentIds: ids, attachments: [{ ...good, objectId: "obj_elsewhere" }] }), [],
    at("metadata cannot introduce an id the authoritative list omits"));

  // Path separators would land in a save dialog's default filename.
  for (const hostile of ["../../etc/passwd", "a/b.png", "a\\b.png", ".", ".."]) {
    assert.deepEqual(view({ attachmentIds: ids, attachments: [{ ...good, originalName: hostile }] }).map((row) => row.originalName),
      [undefined], at(`a path-bearing name is dropped, not sanitized: ${JSON.stringify(hostile)}`));
  }

  // A row with nothing trustworthy left is omitted entirely rather than
  // rendering an empty card where a download action used to be.
  assert.deepEqual(view({ attachmentIds: ids, attachments: [{ objectId: "obj_a", mimeType: "not-a-mime", sizeBytes: -3 }] }), [],
    at("a row with no usable field is omitted"));

  // Partial data is still useful: a size with no name beats no card at all.
  assert.deepEqual(view({ attachmentIds: ids, attachments: [{ objectId: "obj_a", sizeBytes: 10 }] }),
    [{ objectId: "obj_a", sizeBytes: 10 }], at("partial metadata survives"));

  assert.equal(view({ attachmentIds: ids, attachments: [good, { ...good, originalName: "second.png" }] }).length, 1,
    at("a duplicate objectId cannot render twice"));

  // Case is normalized so the renderer's `startsWith("image/")` cannot be
  // defeated by an upper-case type.
  assert.equal(view({ attachmentIds: ids, attachments: [{ ...good, mimeType: "IMAGE/PNG" }] })[0].mimeType, "image/png",
    at("mime type is lower-cased"));

  for (const shape of [undefined, null, "nope", 7, {}, [null], [7], [{ objectId: 5 }]]) {
    assert.deepEqual(view({ attachmentIds: ids, attachments: shape }), [], at(`a malformed container yields none: ${JSON.stringify(shape)}`));
  }

  // Bounded against a hostile or buggy peer.
  const many = Array.from({ length: 60 }, (_, index) => ({ objectId: `o${index}`, originalName: `f${index}.png` }));
  assert.ok(view({ attachmentIds: many.slice(0, 20).map((row) => row.objectId), attachments: many }).length <= 20,
    at("the metadata list is bounded"));
}

// Defense in depth, and the reason the revocation check is not redundant: the
// callers above blank the id list for a revoked message, so the loop's revoked
// case short-circuits on the empty list and proves nothing. Hand each layer a
// revoked message WITH ids — a caller that forgot to blank them — and the
// metadata must still be withheld.
assert.deepEqual(attachmentMetadata({ revokedAt: "2026-01-01T00:00:00Z", attachments: [good] }, ids), [],
  "client: a revoked message withholds metadata even when handed a non-empty id list");
assert.deepEqual(attachmentMetadataView({ attachments: [good] }, ids, true), [],
  "server: a revoked message withholds metadata even when handed a non-empty id list");

// ---- The id list is the invariant metadata must never touch. ---------------
{
  const message = { attachmentIds: ["obj_a", "obj_b"], attachments: [{ objectId: "obj_b", originalName: "b.png" }] };
  assert.deepEqual(attachmentIds(message), ["obj_a", "obj_b"], "ids keep their order and count when only one carries metadata");
  const view = attachmentMetadata(message, attachmentIds(message));
  assert.deepEqual(view.map((row) => row.objectId), ["obj_b"], "an id without metadata simply has none");
}

// The server join must be a LEFT join: an inner join would silently drop an
// attachment whose object row is gone, shortening the list that authorizes
// and addresses downloads.
{
  const repository = fs.readFileSync(path.join(ROOT, "server/src/services/collaboration/message-repository.js"), "utf8");
  const listHistory = repository.slice(repository.indexOf("async listHistory("));
  assert.ok(/\.leftJoin\(\s*"stored_objects"/.test(listHistory),
    "listHistory must LEFT join stored_objects; an inner join can shorten attachmentIds");
  assert.ok(!/\.innerJoin\(\s*"stored_objects"/.test(listHistory), "no inner join on stored_objects in listHistory");
}

// The IPC boundary must re-derive metadata against the ids it actually projects,
// never trust the record — otherwise a poisoned local row could describe an
// object the renderer was not given the id of.
{
  const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc-collaboration.js"), "utf8");
  assert.ok(/attachmentMetadata\(value,\s*attachmentIds\(value\)\)/.test(ipc),
    "the renderer projection must pass the projected id list into attachmentMetadata");
}

console.log("collaboration-attachment-metadata: ok");
