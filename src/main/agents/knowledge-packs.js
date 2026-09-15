"use strict";

/**
 * Knowledge pack registry — the generalization of the one hard-coded
 * coupling the codebase had (`lily-cn-legal-counsel` → legal knowledge pack).
 *
 * A pack is a deterministic, host-installed corpus plus the broker tools that
 * read it. Agents reference packs by id in `knowledge.packs`; the turn
 * preparation step ensures every referenced pack is installed and indexed
 * before the model runs, exactly the way the legal role already worked.
 *
 * Adding a pack = adding an entry here (id, labels, ensure/status, tools).
 * The code never guesses: an unknown pack id is reported, never invented.
 */

const PACKS = Object.freeze({
  "legal-cn-enterprise": Object.freeze({
    id: "legal-cn-enterprise",
    labels: Object.freeze({
      "zh-CN": "中国企业法律知识库",
      en: "China enterprise legal knowledge pack",
      ar: "حزمة المعرفة القانونية للشركات في الصين",
    }),
    tools: Object.freeze(["lily_legal_search"]),
    // Lazy: the legal module pulls the installer + search index.
    manager: () => require("../legal-kb/legal-kb-manager"),
    ensure(options = {}) {
      // An injected manager (ctx.legalKnowledgeManager / tests) wins; it may
      // expose either the legacy `ensure` or `ensureLegalKnowledgePack`.
      const manager = options.manager || this.manager();
      const ensure = manager.ensureLegalKnowledgePack || manager.ensure;
      if (typeof ensure !== "function") return Promise.resolve({ ok: false, error: "LEGAL_KB_MANAGER_UNAVAILABLE" });
      return ensure.call(manager, { onProgress: options.onProgress });
    },
    status() {
      try {
        return this.manager().status();
      } catch (error) {
        return { ok: false, packId: this.id, installed: false, error: error?.message || "STATUS_FAILED" };
      }
    },
  }),
});

function listKnowledgePacks() {
  return Object.values(PACKS).map((pack) => ({ id: pack.id, labels: { ...pack.labels }, tools: [...pack.tools] }));
}

function getKnowledgePack(packId) {
  return PACKS[String(packId || "").trim().toLowerCase()] || null;
}

function knowledgePackLabel(packId, locale = "zh-CN") {
  const pack = getKnowledgePack(packId);
  if (!pack) return String(packId || "");
  return pack.labels[locale] || pack.labels.en || pack.id;
}

/**
 * Ensure a set of packs is ready. Sequential and bounded; returns one
 * structured result per pack plus an aggregate. A pack failure is reported by
 * id — the caller (turn preparation) decides whether to block the turn.
 */
async function ensureKnowledgePacks(packIds, options = {}) {
  const results = [];
  for (const rawId of Array.isArray(packIds) ? packIds : []) {
    const pack = getKnowledgePack(rawId);
    if (!pack) {
      results.push({ packId: String(rawId), ready: false, error: "KNOWLEDGE_PACK_UNKNOWN" });
      continue;
    }
    try {
      const result = await pack.ensure({ onProgress: options.onProgress, manager: options.manager });
      results.push(result?.ok
        ? { packId: pack.id, ready: true, version: result.version || "", path: result.path || "", skipped: Boolean(result.skipped) }
        : { packId: pack.id, ready: false, error: result?.error || "KNOWLEDGE_PACK_UNAVAILABLE" });
    } catch (error) {
      results.push({ packId: pack.id, ready: false, error: error?.message || "KNOWLEDGE_PACK_UNAVAILABLE" });
    }
  }
  const failed = results.filter((item) => !item.ready);
  return {
    required: results.length > 0,
    ready: failed.length === 0,
    packs: results,
    error: failed[0]?.error || null,
    failedPackId: failed[0]?.packId || null,
  };
}

module.exports = { listKnowledgePacks, getKnowledgePack, knowledgePackLabel, ensureKnowledgePacks };
