"use strict";

/**
 * Knowledge preparation before a turn runs.
 *
 * Two sources decide which knowledge packs a turn needs:
 *   1. the legacy rule — the official China legal counsel ROLE always needs
 *      the legal pack (kept verbatim so existing conversations behave the same);
 *   2. the bound 智能体's `knowledge.packs` (docs/agent-management-design.md).
 * Both resolve to pack ids; knowledge-packs.js installs/indexes them.
 *
 * Knowledge never blocks the answer. It used to: a pack that could not be
 * prepared failed the turn outright, and preparing meant asking the server for
 * the latest artifact on EVERY turn — so a network blip or an entitlement call
 * that failed once made the legal role unusable, even with a valid pack already
 * installed on the machine (a user saw "处理失败 · 官方法律角色需要授权的法律知识库…"
 * three turns running). Now:
 *   - a pack installed on this machine is used as it is, at once;
 *   - installing, updating and indexing run in the background, one at a time,
 *     and never hold a turn;
 *   - a turn whose pack is not ready still answers, told plainly that the
 *     knowledge base is unavailable (so it does not claim citations it could
 *     not check), and the user sees why; the cause is recorded, not swallowed.
 */

const { LEGAL_CHARACTER_ID, requiresLegalKnowledge } = require("./legal-kb-character");

const LEGAL_PACK_ID = "legal-cn-enterprise";

function characterRevisionOf({ ctx, session, state }) {
  const snapshot = state?.characterWorldsSnapshot;
  if (snapshot?.snapshotStatus !== "ready" || snapshot.mode !== "character" || !snapshot.characterRevisionId) return null;
  const owner = ctx.sessionManager?.resolveTurnOwnerScope?.(session.id);
  const repository = ctx.characterWorldsRepository
    || ctx.sessionManager?._store?.()?.characterWorlds?.()
    || null;
  return owner?.ok && repository?.getRevision
    ? repository.getRevision(owner.ownerScope, snapshot.characterRevisionId)
    : null;
}

function agentPacksOf(ctx, sessionId) {
  try {
    const { resolveSessionAgentPolicy } = require("../agents/session-agent-policy");
    return [...(resolveSessionAgentPolicy(ctx, sessionId).knowledgePacks || [])];
  } catch {
    return [];
  }
}

// Whether a pack is on this machine now: "ready", "missing", or "unknown" (no
// such pack). An injected manager speaks only for the pack it manages, exactly
// as pack.ensure uses it.
function localPackState(packId, manager) {
  try {
    const pack = require("../agents/knowledge-packs").getKnowledgePack(packId);
    if (!pack) return "unknown";
    const status = packId === LEGAL_PACK_ID && typeof manager?.status === "function" ? manager.status() : pack.status();
    // `usable` = installed and entitled; a manager that predates it reports installed only.
    if (status?.usable === false) return status.unusableCode === "LEGAL_KB_NOT_READY" ? "missing" : "denied";
    return status?.installed ? "ready" : "missing";
  } catch {
    return "missing";
  }
}

// One background preparation per pack set at a time; a turn only starts it.
const warming = new Map();

function warmInBackground(packIds, { manager, onProgress, log }) {
  const key = [...packIds].sort().join(",");
  if (warming.has(key)) return warming.get(key);
  const run = require("../agents/knowledge-packs").ensureKnowledgePacks(packIds, { manager, onProgress })
    .then((result) => {
      if (!result.ready) {
        require("../diagnostics/swallowed-failure").recordSwallowedFailure("knowledge pack preparation", result.error || "KNOWLEDGE_PACK_UNAVAILABLE", { pack: result.failedPackId || key });
      }
      return result;
    })
    .catch((error) => {
      log?.warn?.("knowledge pack preparation failed: %s", error?.message || error);
      require("../diagnostics/swallowed-failure").recordSwallowedFailure("knowledge pack preparation", error, { pack: key });
      return { ready: false, error: error?.message || "KNOWLEDGE_PACK_UNAVAILABLE" };
    })
    .finally(() => warming.delete(key));
  warming.set(key, run);
  return run;
}

async function prepareLegalKnowledgeForTurn({ ctx, session, state, options, log }) {
  const packs = new Set();
  try {
    const revision = characterRevisionOf({ ctx, session, state });
    if (revision && requiresLegalKnowledge(revision)) packs.add(LEGAL_PACK_ID);
  } catch (error) {
    log?.warn?.("knowledge preparation: character revision lookup failed open: %s", error?.message || error);
  }
  for (const id of agentPacksOf(ctx, session?.id)) packs.add(id);
  if (!packs.size) return { required: false, ready: true, packs: [] };
  const ids = [...packs];
  const status = ids.map((packId) => {
    const local = localPackState(packId, ctx.legalKnowledgeManager);
    const error = local === "unknown" ? "KNOWLEDGE_PACK_UNKNOWN" : local === "denied" ? "KNOWLEDGE_PACK_NOT_ENTITLED" : undefined;
    return { packId, ready: local === "ready", ...(error ? { error } : {}) };
  });
  warmInBackground(ids, { manager: ctx.legalKnowledgeManager, onProgress: options?.onProgress, log });
  const missing = status.find((item) => !item.ready);
  return {
    required: true,
    ready: !missing,
    packs: status,
    error: missing ? (missing.error || "KNOWLEDGE_PACK_NOT_READY") : undefined,
    failedPackId: missing?.packId || null,
  };
}

/**
 * What a turn whose knowledge is not ready carries: an instruction so the
 * model answers honestly without it, and a notice so the user knows. The turn
 * itself always runs.
 */
function knowledgeUnavailable(legalKnowledge = {}) {
  if (!legalKnowledge.required || legalKnowledge.ready) return null;
  const { detail } = knowledgeFailure(legalKnowledge);
  const refused = legalKnowledge.error === "KNOWLEDGE_PACK_NOT_ENTITLED";
  return {
    instruction: [
      "The knowledge base this role relies on is NOT available on this turn (it is still being prepared or could not be reached).",
      "Answer the user anyway, from general knowledge and any tools that do work, but say once, briefly, that the answer was not checked against the knowledge base.",
      "Do not claim to have searched or cited it, and mark any specific statute or article you name as unverified.",
    ].join(" "),
    notice: refused
      ? "当前账号未获授权使用这个知识库（或授权已到期）。本轮已照常回答，但未经知识库核对。"
      : `${detail.replace(/请检查账号权限和网络后重试。$/, "")}本轮已照常回答，但未经知识库核对；知识库会在后台继续准备。`,
  };
}

/** Terminal copy + code for a knowledge pack that could not be prepared. */
function knowledgeFailure(legalKnowledge = {}) {
  const failedPackId = String(legalKnowledge.failedPackId || "");
  const isLegal = !failedPackId || failedPackId === LEGAL_PACK_ID;
  let packLabel = failedPackId;
  try { packLabel = require("../agents/knowledge-packs").knowledgePackLabel(failedPackId, "zh-CN"); } catch { /* id */ }
  return {
    code: isLegal ? "LEGAL_KB_UNAVAILABLE" : "KNOWLEDGE_PACK_UNAVAILABLE",
    detail: isLegal
      ? "官方法律角色需要授权的法律知识库，当前未能准备完成。请检查账号权限和网络后重试。"
      : `当前智能体需要的知识库「${packLabel}」未能准备完成。请检查账号权限和网络后重试。`,
  };
}

/** The engine text for this turn, told about knowledge that is not ready; the user is told too. */
function withKnowledgeAvailability(orchestrator, sessionId, engineText, state) {
  const unavailable = knowledgeUnavailable(state?.legalKnowledge);
  if (!unavailable) return engineText;
  try {
    const { engineNotice } = require("../../shared/engine-notices.mjs");
    orchestrator?._emitEngineNotice?.(sessionId, engineNotice("legalKnowledgePackProgress", {
      replaces: "legalKnowledgePackProgress", level: "warning", done: true, detail: unavailable.notice,
    }));
  } catch { /* the notice is a courtesy; the instruction below is what matters */ }
  const { addLayersToEngineText } = require("../engine-message-layers");
  return addLayersToEngineText(engineText, { executionConstraints: unavailable.instruction });
}

/** Settles when background preparation now in flight is done (tests, diagnostics). */
function knowledgeWarmups() {
  return Promise.all([...warming.values()]);
}

module.exports = { prepareLegalKnowledgeForTurn, knowledgeFailure, knowledgeUnavailable, withKnowledgeAvailability, knowledgeWarmups, LEGAL_CHARACTER_ID, LEGAL_PACK_ID };
