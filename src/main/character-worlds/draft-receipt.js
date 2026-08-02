"use strict";

const { types: utilTypes } = require("node:util");
const { CharacterWorldsReceiptStore } = require("./receipt-store");

const KINDS = new Set(["character", "persona", "worldBook"]);

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function revisionFor(repository, ownerScope, kind, revisionId) {
  if (kind === "character") return repository.getRevision(ownerScope, revisionId);
  if (kind === "persona") return repository.getPersonaRevision(ownerScope, revisionId);
  return repository.getWorldBookRevision(ownerScope, revisionId);
}

function entityIdOf(kind, revision) {
  if (kind === "character") return revision?.characterId;
  if (kind === "persona") return revision?.personaId;
  return revision?.worldBookId;
}

function receiptBlock(receipt) {
  return Object.freeze({
    id: `character-worlds-receipt:${receipt.id}`,
    type: "character_worlds_receipt",
    schemaVersion: 1,
    receiptId: receipt.id,
    ...receipt.safe,
  });
}

class DraftReceiptBuilder {
  constructor({ repository, store = null } = {}) {
    if (!repository?.db) throw new TypeError("draft receipt builder requires repository");
    this.repository = repository;
    this.store = store || new CharacterWorldsReceiptStore({ repository });
  }

  create({ ownerScope, sessionId, turnId, evidence }) {
    if (!plain(evidence) || evidence.name !== "lily_character_draft") return null;
    const input = plain(evidence.input) ? evidence.input : null;
    const result = plain(evidence.result) ? evidence.result : null;
    const kind = input?.kind;
    if (!KINDS.has(kind) || result?.ok !== true) return null;
    if (![ownerScope, sessionId, turnId, evidence.callId, result.entityId, result.revisionId]
      .every((value) => typeof value === "string" && value.length > 0)) return null;
    let revision;
    try {
      revision = revisionFor(this.repository, ownerScope, kind, result.revisionId);
    } catch {
      return null;
    }
    if (!revision || entityIdOf(kind, revision) !== result.entityId) return null;
    if (revision.source?.kind !== "agent_draft") return null;
    if (Number(result.revisionNumber) !== Number(revision.revisionNumber)) return null;
    const displayName = String(revision.name || revision.canonical?.name || "Untitled").trim().slice(0, 160);
    if (!displayName) return null;
    const safe = {
      kind,
      displayName,
      summary: `${kind === "worldBook" ? "World book" : kind === "persona" ? "Persona" : "Character"} draft created`,
      revisionNumber: revision.revisionNumber,
      state: "draft",
      provenance: "agent_draft",
    };
    const receipt = this.store.create({
      ownerScope, sessionId, turnId, toolCallId: evidence.callId,
      kind, entityId: result.entityId, revisionId: result.revisionId, safe,
    });
    return receipt ? receiptBlock(receipt) : null;
  }
}

module.exports = { DraftReceiptBuilder, receiptBlock };
