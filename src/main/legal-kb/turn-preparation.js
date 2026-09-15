"use strict";

/**
 * Knowledge preparation before a turn runs.
 *
 * Two sources decide which knowledge packs a turn needs:
 *   1. the legacy rule — the official China legal counsel ROLE always needs
 *      the legal pack (kept verbatim so existing conversations behave the same);
 *   2. the bound 智能体's `knowledge.packs` (docs/agent-management-design.md).
 * Both resolve to pack ids; knowledge-packs.js installs/indexes them. A pack
 * that cannot be prepared blocks the turn with a named error (the model must
 * not answer legal questions blind), exactly as the legal role did before.
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
  try {
    const { ensureKnowledgePacks } = require("../agents/knowledge-packs");
    const result = await ensureKnowledgePacks([...packs], {
      onProgress: options?.onProgress,
      manager: ctx.legalKnowledgeManager,
    });
    return {
      required: true,
      ready: result.ready,
      packs: result.packs,
      error: result.ready ? undefined : (result.error || "KNOWLEDGE_PACK_UNAVAILABLE"),
      failedPackId: result.failedPackId || null,
    };
  } catch (error) {
    log?.warn?.("knowledge pack preparation failed: %s", error?.message || error);
    return { required: true, ready: false, packs: [...packs].map((packId) => ({ packId, ready: false })), error: "KNOWLEDGE_PACK_UNAVAILABLE", failedPackId: [...packs][0] };
  }
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

module.exports = { prepareLegalKnowledgeForTurn, knowledgeFailure, LEGAL_CHARACTER_ID, LEGAL_PACK_ID };
