#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { downloadArtifact } = require("../src/main/runtime-pack-download.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-download-"));
const payload = Buffer.alloc(256 * 1024, 0x5a);
const requests = [];
let transientFailures = 0;

const server = http.createServer((request, response) => {
  requests.push({ url: request.url, range: request.headers.range || "" });
  if (request.url === "/retry" && transientFailures++ === 0) {
    response.writeHead(503);
    response.end("retry");
    return;
  }
  const range = String(request.headers.range || "");
  const offset = Number(range.match(/^bytes=(\d+)-$/)?.[1] || 0);
  const body = payload.subarray(offset);
  const headers = {
    "content-length": body.length,
    etag: '"fixture-v1"',
  };
  if (offset) headers["content-range"] = `bytes ${offset}-${payload.length - 1}/${payload.length}`;
  response.writeHead(offset ? 206 : 200, headers);
  response.end(body);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const partPath = path.join(tmp, "resume.part");
  const partialBytes = 32 * 1024;
  fs.writeFileSync(partPath, payload.subarray(0, partialBytes));
  const progress = [];
  const resumed = await downloadArtifact({
    url: `${baseUrl}/resume`,
    partPath,
    expectedBytes: payload.length,
    maxBytes: payload.length + 1024,
    maxAttempts: 3,
    freeBytes: async () => payload.length * 3,
    onProgress: (item) => progress.push(item),
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  assert.equal(fs.readFileSync(partPath).equals(payload), true);
  assert.equal(requests.some((request) => request.range === `bytes=${partialBytes}-`), true);
  assert.equal(progress.at(-1)?.writtenBytes, payload.length);

  const retryPath = path.join(tmp, "retry.part");
  const retried = await downloadArtifact({
    url: `${baseUrl}/retry`,
    partPath: retryPath,
    expectedBytes: payload.length,
    maxBytes: payload.length + 1024,
    maxAttempts: 2,
    retryDelaysMs: [1],
    freeBytes: async () => payload.length * 3,
  });
  assert.equal(retried.ok, true);
  assert.equal(transientFailures, 2);

  const requestsBeforeSpaceCheck = requests.length;
  const insufficient = await downloadArtifact({
    url: `${baseUrl}/space`,
    partPath: path.join(tmp, "space.part"),
    expectedBytes: payload.length,
    maxBytes: payload.length + 1024,
    freeBytes: async () => payload.length,
  });
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.error, "INSUFFICIENT_DISK_SPACE");
  assert.equal(requests.length, requestsBeforeSpaceCheck, "disk-space failure must happen before network I/O");

  console.log("runtime-pack-download: ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
