#!/usr/bin/env node
// lily-preview:// serves an HTML artifact's workspace to the page that runs in
// the preview pane — and nothing else: never userData, never a path out of
// the workspace (by ../ or a symlink), never a workspace the app does not list.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { previewUrlForPath, resolvePreviewRequest } = require("../src/main/preview-protocol.js");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-preview-")));
try {
  const ws = path.join(tmp, "工作区 test");
  fs.mkdirSync(path.join(ws, "output", "app"), { recursive: true });
  fs.writeFileSync(path.join(ws, "output", "app", "index.html"), "<h1>看板</h1>");
  fs.writeFileSync(path.join(ws, "output", "data.json"), "{}");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "key");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(ws, "output", "link.txt"));
  const roots = [ws];

  const made = previewUrlForPath(path.join(ws, "output", "app", "index.html"), { roots });
  assert.equal(made.ok, true);
  assert.match(made.url, /^lily-preview:\/\/w[0-9a-f]{16}\/output\/app\/index\.html$/);
  const host = new URL(made.url).hostname;

  const page = resolvePreviewRequest(made.url, { roots });
  assert.equal(page.status, 200);
  assert.equal(page.mime, "text/html; charset=utf-8");
  assert.equal(resolvePreviewRequest(`lily-preview://${host}/output/data.json`, { roots }).mime, "application/json; charset=utf-8",
    "the page's own data file is served with its type (fetch('../data.json') works)");

  assert.equal(resolvePreviewRequest(`lily-preview://${host}/../secret.txt`, { roots }).status === 200, false, "../ never leaves the workspace");
  assert.notEqual(resolvePreviewRequest(`lily-preview://${host}/output/%2e%2e/%2e%2e/secret.txt`, { roots }).status, 200, "an encoded ../ never leaves the workspace");
  assert.equal(resolvePreviewRequest(`lily-preview://${host}/output/link.txt`, { roots }).status, 403, "a symlink never leads out of the workspace");
  assert.equal(resolvePreviewRequest(`lily-preview://wffffffffffffffff/output/data.json`, { roots }).status, 404, "an unknown workspace is not served");
  assert.equal(previewUrlForPath(path.join(tmp, "secret.txt"), { roots }).error, "NOT_IN_WORKSPACE", "a file outside every workspace gets no preview origin");
  assert.equal(resolvePreviewRequest(`lily-preview://${host}/output/app`, { roots }).status, 404, "a directory is not a file");
  console.log("preview-protocol: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
