#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fetchArtifactBuffer } = require("../src/main/artifact-download.js");

const payload = Buffer.from("zip-bytes");
let attempts = 0;
let seenAcceptEncoding = "";

const server = http.createServer((req, res) => {
  attempts += 1;
  seenAcceptEncoding = String(req.headers["accept-encoding"] || "");
  if (req.url === "/retry" && attempts === 1) {
    req.socket.destroy();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": payload.length,
  });
  res.end(payload);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

try {
  const buffer = await fetchArtifactBuffer(`http://127.0.0.1:${port}/retry`, {
    timeoutMs: 10_000,
    maxBytes: 1024,
  });
  assert.deepEqual(buffer, payload);
  assert.equal(attempts, 2);
  assert.equal(seenAcceptEncoding, "identity");

  await assert.rejects(
    () => fetchArtifactBuffer(`http://127.0.0.1:${port}/too-large`, {
      timeoutMs: 10_000,
      maxBytes: payload.length - 1,
    }),
    /ARTIFACT_TOO_LARGE/,
  );
} finally {
  server.close();
}

console.log("artifact-download: ok");
