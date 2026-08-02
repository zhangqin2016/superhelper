#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { CharacterAuthoringService } = require("../src/main/character-worlds/authoring-service.js");
const { DraftReceiptBuilder } = require("../src/main/character-worlds/draft-receipt.js");
const { ReceiptActionBroker } = require("../src/main/character-worlds/receipt-actions.js");
const { resolveCharacterWorldsAdjustment } = require("../src/main/character-worlds/adjustment-context.js");
const { buildCharacterDraftTool } = require("../src/main/character-worlds/agent-draft-tools.js");
const { resolveEngineRouting } = require("../src/main/ipc-assistant.js");

const OWNER = "profile:refinement";
const SESSION = "session-refinement";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-refinement-loop-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = store.characterWorlds();

try {
  const created = repository.createCharacter({
    ownerScope: OWNER,
    canonical: { name: "Mira", description: "Warm and playful.", personality: "Affectionate." },
    source: { kind: "agent_draft", format: "lily", container: "json" },
  });
  const receipt = new DraftReceiptBuilder({ repository }).create({
    ownerScope: OWNER, sessionId: SESSION, turnId: "turn-create",
    evidence: {
      name: "lily_character_draft", callId: "call-create",
      input: { action: "create", kind: "character" },
      result: { ok: true, entityId: created.entity.id, revisionId: created.revision.id, revisionNumber: 1 },
    },
  });
  const broker = new ReceiptActionBroker();
  const handle = broker.issue({
    ownerScope: OWNER, sessionId: SESSION, receiptId: receipt.receiptId, action: "authoring",
  });
  const ctx = {
    characterWorldsRepository: repository,
    characterWorldsActionBroker: broker,
    sessionManager: { resolveTurnOwnerScope: () => ({ ok: true, ownerScope: OWNER }) },
  };
  const adjustment = resolveCharacterWorldsAdjustment(ctx, { id: SESSION }, handle);
  assert.deepEqual(adjustment, {
    active: true, action: "revise", kind: "character", targetReceiptId: receipt.receiptId,
  });
  const routed = resolveEngineRouting("再独立一点", [], null, adjustment);
  assert.deepEqual(routed.requiredSuccessfulTools, ["lily_character_draft"]);
  assert.match(routed.engineText, /action=revise/);
  assert.match(routed.engineText, new RegExp(receipt.receiptId));
  assert.doesNotMatch(routed.engineText, new RegExp(created.entity.id));
  assert.doesNotMatch(routed.engineText, new RegExp(created.revision.id));

  const authoring = new CharacterAuthoringService({ repository, resolveOwnerScope: async () => OWNER });
  const tool = buildCharacterDraftTool({
    characterAuthoringService: authoring,
    resolveOwnerScope: async () => OWNER,
    characterWorldsPolicy: () => ({ enabled: true }),
  });
  const result = await tool.handler({
    action: "revise",
    kind: "character",
    targetReceiptId: receipt.receiptId,
    canonical: { name: "Mira", description: "Warm, playful, and self-directed.", personality: "Affectionate with clear boundaries." },
  }, { platformOnly: true, characterWorlds: { enabled: true, ownerScope: OWNER } }, {});
  assert.equal(result.ok, true);
  assert.equal(result.entityId, created.entity.id);
  assert.equal(result.revisionNumber, 2);
  assert.notEqual(result.revisionId, created.revision.id);
  assert.equal(resolveCharacterWorldsAdjustment(ctx, { id: SESSION }, handle), null, "handle is one-use");
  console.log("PASS: test-character-worlds-refinement-loop");
} finally {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
