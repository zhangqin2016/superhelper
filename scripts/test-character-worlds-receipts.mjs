#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { DraftReceiptBuilder } = require("../src/main/character-worlds/draft-receipt.js");
const { CharacterWorldsReceiptStore } = require("../src/main/character-worlds/receipt-store.js");
const { ReceiptActionBroker } = require("../src/main/character-worlds/receipt-actions.js");

const OWNER = "profile:receipts";
const SESSION = "session-receipts";
const TURN = "turn-receipts";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-character-receipts-"));
const messageStore = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = messageStore.characterWorlds();

try {
  const created = repository.createPersona({
    ownerScope: OWNER,
    canonical: { schemaVersion: 1, name: "Lead", description: "Evidence first." },
    source: { kind: "agent_draft", format: "lily", container: "json" },
  });
  const evidence = {
    name: "lily_character_draft",
    callId: "call-1",
    input: { action: "create", kind: "persona", entityId: "", expectedBaseRevisionId: "" },
    result: {
      ok: true,
      entityId: created.entity.id,
      revisionId: created.revision.id,
      revisionNumber: 1,
    },
  };
  const builder = new DraftReceiptBuilder({ repository });
  const block = builder.create({ ownerScope: OWNER, sessionId: SESSION, turnId: TURN, evidence });
  assert.equal(block.type, "character_worlds_receipt");
  assert.equal(block.kind, "persona");
  assert.equal(block.displayName, "Lead");
  assert.equal(block.provenance, "agent_draft");
  assert.equal(Object.hasOwn(block, "entityId"), false);
  assert.equal(Object.hasOwn(block, "revisionId"), false);

  const duplicate = builder.create({ ownerScope: OWNER, sessionId: SESSION, turnId: TURN, evidence });
  assert.deepEqual(duplicate, block, "duplicate tool delivery reuses the immutable receipt");
  assert.equal(messageStore.db.get("SELECT COUNT(*) AS count FROM character_worlds_receipts").count, 1);

  for (const invalid of [
    { ...evidence, callId: "", result: { ...evidence.result } },
    { ...evidence, callId: "call-wrong-kind", input: { ...evidence.input, kind: "character" } },
    { ...evidence, callId: "call-wrong-entity", result: { ...evidence.result, entityId: "foreign" } },
    { ...evidence, callId: "call-wrong-revision", result: { ...evidence.result, revisionId: "missing" } },
    { ...evidence, callId: "call-failed", result: { ...evidence.result, ok: false } },
  ]) {
    assert.equal(builder.create({ ownerScope: OWNER, sessionId: SESSION, turnId: TURN, evidence: invalid }), null);
  }
  assert.equal(builder.create({ ownerScope: "profile:foreign", sessionId: SESSION, turnId: TURN, evidence }), null);
  assert.equal(builder.create({ ownerScope: OWNER, sessionId: SESSION, turnId: TURN, evidence: new Proxy({}, {}) }), null);

  const persisted = new CharacterWorldsReceiptStore({ repository }).get(
    OWNER, SESSION, block.receiptId,
  );
  assert.equal(persisted.safe.displayName, "Lead");
  assert.throws(() => messageStore.db.run(
    "UPDATE character_worlds_receipts SET kind = 'character' WHERE id = ?", block.receiptId,
  ), /immutable/);

  let now = 1000;
  const actions = new ReceiptActionBroker({ now: () => now });
  const activate = actions.issue({ ownerScope: OWNER, sessionId: SESSION, receiptId: block.receiptId, action: "activate" });
  assert.equal(actions.consume({ token: activate, ownerScope: OWNER, sessionId: SESSION, receiptId: block.receiptId, action: "activate" }), true);
  assert.equal(actions.consume({ token: activate, ownerScope: OWNER, sessionId: SESSION, receiptId: block.receiptId, action: "activate" }), false);
  const view = actions.issue({ ownerScope: OWNER, sessionId: SESSION, receiptId: block.receiptId, action: "view" });
  assert.equal(actions.consume({ token: view, ownerScope: OWNER, sessionId: SESSION, receiptId: block.receiptId, action: "view" }), true);
  assert.equal(actions.consume({ token: view, ownerScope: OWNER, sessionId: SESSION, receiptId: block.receiptId, action: "view" }), true);
  now += 16 * 60 * 1000;
  assert.equal(actions.consume({ token: view, ownerScope: OWNER, sessionId: SESSION, receiptId: block.receiptId, action: "view" }), false);

  console.log("PASS: test-character-worlds-receipts");
} finally {
  messageStore.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
