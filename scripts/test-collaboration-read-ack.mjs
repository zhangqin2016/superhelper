import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");
const { createCollaborationClient } = require("../src/main/collaboration/client.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-read-ack-"));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString(),
} });
const store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
let response = { ok: true, result: { lastReadSeq: 5 } };
const client = createCollaborationClient({
  accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "test-only" }) },
  signDeviceRequest: async () => ({}),
  request: async ({ path: route, body }) => {
    assert.equal(route, "/api/collaboration/v1/messages");
    assert.equal(body.action, "read");
    return { ok: true, status: 200, json: response };
  },
});
const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device-a", realtimeEnabled: false });
const events = [];
service.subscribe((event) => events.push(event));
try {
  const ids = ["c", "higher", "zero", ...Array.from({ length: 9 }, (_, i) => `invalid-${i}`)];
  store.replaceProjectionFromBootstrap({ conversations: ids.map((id) => ({ id, kind: "direct" })) });
  assert.deepEqual(await service.markRead({ conversationId: "c", seq: 99 }), { ok: true, conversationId: "c", seq: 5 },
    "the actual HTTP envelope carries the authoritative clamped read sequence, not the optimistic request");
  response = { ok: true, result: { lastReadSeq: 100 } };
  assert.equal((await service.markRead({ conversationId: "higher", seq: 2 })).seq, 100,
    "an already-higher server read watermark remains authoritative");
  response = { ok: true, result: { lastReadSeq: 0 } };
  assert.equal((await service.markRead({ conversationId: "zero", seq: 99 })).seq, 0);
  assert.equal((await service.markRead({ conversationId: "c", seq: 200 })).seq, 0, "return the actual valid HTTP ACK even when lower than the stored watermark");
  assert.equal(require("../src/main/collaboration/read-checkpoint").getReadCheckpoint(store, "c").confirmedSeq, 5, "persisted confirmed state cannot regress with an artificial lower ACK");
  const eventCount = events.length;
  let malformedIndex = 0;
  for (const malformed of [{}, { lastReadSeq: 99 }, { ok: false, result: { lastReadSeq: 99 } }, ...[null, "5", -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((lastReadSeq) => ({ ok: true, result: { lastReadSeq } }))]) {
    response = malformed;
    assert.deepEqual(await service.markRead({ conversationId: `invalid-${malformedIndex++}`, seq: 99 }), { ok: false, code: "COLLAB_READ_ACK_INVALID" },
      "an absent or malformed acknowledgment never silently substitutes the requested read sequence");
  }
  assert.equal(events.length, eventCount, "invalid ACKs do not announce confirmed read state");
  console.log("collaboration read ACK: authoritative HTTP envelope and invalid-response fencing passed");
} finally { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
