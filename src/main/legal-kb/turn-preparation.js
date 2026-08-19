"use strict";

async function prepareLegalKnowledgeForTurn({ ctx, session, state, options, log }) {
  const snapshot = state?.characterWorldsSnapshot;
  if (snapshot?.snapshotStatus !== "ready" || snapshot.mode !== "character" || !snapshot.characterRevisionId) {
    return { required: false, ready: true };
  }
  try {
    const owner = ctx.sessionManager?.resolveTurnOwnerScope?.(session.id);
    const repository = ctx.characterWorldsRepository
      || ctx.sessionManager?._store?.()?.characterWorlds?.()
      || null;
    const revision = owner?.ok && repository?.getRevision
      ? repository.getRevision(owner.ownerScope, snapshot.characterRevisionId)
      : null;
    if (!revision) return { required: false, ready: true };
    const { ensureLegalKnowledgeForRevision } = require("./legal-kb-character");
    return ensureLegalKnowledgeForRevision(revision, {
      manager: ctx.legalKnowledgeManager,
      onProgress: options?.onProgress,
    });
  } catch (error) {
    log.warn("legal knowledge pack preparation failed: %s", error?.message || error);
    return { required: false, ready: true, error: "REVISION_UNAVAILABLE" };
  }
}

module.exports = { prepareLegalKnowledgeForTurn };
