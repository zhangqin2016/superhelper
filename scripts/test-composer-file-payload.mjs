#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  attachmentDisplayPayload,
  attachmentSendPayload,
} from "../src/renderer/modules/attachment-payload.js";

const pending = {
  id: "folder-1",
  name: "customer-folder",
  path: "/data/customer-folder",
  sourcePath: "/data/customer-folder",
  type: "directory",
  size: 0,
  isImage: false,
  kind: "directory",
  pathOnly: true,
  readable: true,
  isDirectory: true,
  extension: "",
  thumbnail: "data:image/png;base64,large-preview",
  transientUiState: "not-for-main",
};

const sent = attachmentSendPayload(pending);
assert.equal(sent.kind, "directory");
assert.equal(sent.pathOnly, true);
assert.equal(sent.isDirectory, true);
assert(!("thumbnail" in sent), "send payload excludes thumbnail data");
assert(!("transientUiState" in sent), "send payload is an explicit contract");

const displayed = attachmentDisplayPayload(sent, pending);
assert.equal(displayed.kind, "directory");
assert.equal(displayed.pathOnly, true);
assert.equal(displayed.thumbnail, null, "non-image display payloads never retain thumbnail data");

const imageDisplay = attachmentDisplayPayload(
  attachmentSendPayload({ ...pending, id: "image-1", isImage: true, kind: "image" }),
  { ...pending, id: "image-1", isImage: true, kind: "image" },
);
assert.equal(imageDisplay.thumbnail, pending.thumbnail, "image previews remain display-only");

console.log("composer-file-payload: ok");
