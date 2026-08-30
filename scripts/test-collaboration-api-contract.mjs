#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../server/src/routes/public/collaboration.js", import.meta.url), "utf8");
for (const path of ["/api/collaboration/v1/bootstrap", "/api/collaboration/v1/sync", "/api/collaboration/v1/ack", "/api/collaboration/v1/command-receipt", "/api/collaboration/v1/ws-ticket", "/api/collaboration/v1/friends", "/api/collaboration/v1/messages"]) {
  assert.ok(source.includes(path), `versioned collaboration API must expose ${path}`);
}
assert.match(source, /verifySignedDeviceRequest/);
assert.match(source, /verifyAccessToken/);
assert.match(source, /clientCommandId/);
assert.match(source, /requestId/);
assert.match(source, /retryable/);
assert.match(source, /commandReceiptView/);
assert.match(source, /where\("user_id", "=", account\.userId\).*where\("device_id", "=", account\.deviceId\).*where\("status", "=", "active"\)/s, "receipt lookup locks active account-device binding");
assert.match(source, /collaboration_events/);
assert.match(source, /input: \{ conversationId: event\.conversation_id \}/, "receipt authorization derives the conversation from its immutable event");
assert.doesNotMatch(source.match(/post\("\/api\/collaboration\/v1\/command-receipt"[\s\S]*?post\("\/api\/collaboration\/v1\/ws-ticket"/)?.[0] || "", /conversationId: z\.string/, "receipt route must not accept a client-selected conversation");
const receiptRoute = source.match(/post\("\/api\/collaboration\/v1\/command-receipt"[\s\S]*?post\("\/api\/collaboration\/v1\/ws-ticket"/)?.[0] || "";
assert.doesNotMatch(receiptRoute, /client_command_id", "=", input\.clientCommandId\)\.forUpdate/, "receipt reads must not take a receipt lock before conversation authorization locks");
console.log("collaboration api contract: ok");
