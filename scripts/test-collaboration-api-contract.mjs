#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../server/src/routes/public/collaboration.js", import.meta.url), "utf8");
for (const path of ["/api/collaboration/v1/bootstrap", "/api/collaboration/v1/sync", "/api/collaboration/v1/ack", "/api/collaboration/v1/ws-ticket", "/api/collaboration/v1/friends", "/api/collaboration/v1/messages"]) {
  assert.ok(source.includes(path), `versioned collaboration API must expose ${path}`);
}
assert.match(source, /verifySignedDeviceRequest/);
assert.match(source, /verifyAccessToken/);
assert.match(source, /clientCommandId/);
assert.match(source, /requestId/);
assert.match(source, /retryable/);
console.log("collaboration api contract: ok");
