"use strict";

const LEGAL_CHARACTER_ID = "lily-cn-legal-counsel";

function requiresLegalKnowledge(revision) {
  return revision?.source?.kind === "official"
    && String(revision.source.officialId || "") === LEGAL_CHARACTER_ID;
}

async function ensureLegalKnowledgeForRevision(revision, options = {}) {
  if (!requiresLegalKnowledge(revision)) return { required: false, ready: true };
  const manager = options.manager || require("./legal-kb-manager");
  const ensure = manager.ensure || manager.ensureLegalKnowledgePack;
  if (typeof ensure !== "function") return { required: true, ready: false, error: "LEGAL_KB_MANAGER_UNAVAILABLE" };
  const result = await ensure.call(manager, { onProgress: options.onProgress });
  return result?.ok
    ? { required: true, ready: true, version: result.version || "", path: result.path || "", skipped: Boolean(result.skipped) }
    : { required: true, ready: false, error: result?.error || "LEGAL_KB_UNAVAILABLE", previousPath: result?.previousPath || "" };
}

module.exports = { LEGAL_CHARACTER_ID, requiresLegalKnowledge, ensureLegalKnowledgeForRevision };
