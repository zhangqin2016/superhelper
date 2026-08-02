"use strict";

const { CharacterWorldsReceiptStore } = require("./receipt-store");

function resolveCharacterWorldsAdjustment(ctx, session, handle) {
  if (typeof handle !== "string" || !handle) return null;
  const owner = ctx.sessionManager?.resolveTurnOwnerScope?.(session.id);
  const target = owner?.ok ? ctx.characterWorldsActionBroker?.take?.({
    token: handle,
    ownerScope: owner.ownerScope,
    sessionId: session.id,
    action: "authoring",
  }) : null;
  const repository = ctx.characterWorldsRepository
    || ctx.sessionManager?._store?.()?.characterWorlds?.()
    || null;
  if (!target || !repository) return null;
  const receipt = new CharacterWorldsReceiptStore({ repository }).get(
    owner.ownerScope, session.id, target.receiptId,
  );
  return receipt
    ? { active: true, action: "revise", kind: receipt.kind, targetReceiptId: receipt.id }
    : null;
}

module.exports = { resolveCharacterWorldsAdjustment };
