"use strict";

const { DraftReceiptBuilder } = require("./draft-receipt");
const { buildResultBlocks } = require("../block-protocol");

function buildDraftReceiptBlocks({ ctx, sessionId, turnId, evidence = [], log = null }) {
  if (!Array.isArray(evidence) || evidence.length === 0) return { blocks: [], rejected: 0 };
  try {
    const owner = ctx.sessionManager?.resolveTurnOwnerScope?.(sessionId);
    if (!owner?.ok || !owner.ownerScope) return { blocks: [], rejected: evidence.length };
    const repository = ctx.characterWorldsRepository
      || ctx.sessionManager?._store?.()?.characterWorlds?.()
      || null;
    if (!repository) return { blocks: [], rejected: evidence.length };
    const builder = new DraftReceiptBuilder({ repository });
    const blocks = evidence.map((item) => builder.create({
      ownerScope: owner.ownerScope, sessionId, turnId, evidence: item,
    })).filter(Boolean);
    return { blocks, rejected: evidence.length - blocks.length };
  } catch (error) {
    log?.warn?.("character worlds receipt validation failed: %s", error?.message || error);
    return { blocks: [], rejected: evidence.length };
  }
}

function attachDraftReceipts({ record, ctx, sessionId, turnId, evidence, log }) {
  if (!record || !evidence?.length) return record;
  const receipts = buildDraftReceiptBlocks({ ctx, sessionId, turnId, evidence, log });
  record.resultBlocks = buildResultBlocks({
    extraBlocks: [...(record.resultBlocks || []), ...receipts.blocks],
  });
  if (receipts.rejected) {
    record.meta = { ...(record.meta || {}), characterWorldsReceiptRejected: receipts.rejected };
  }
  return record;
}

module.exports = { attachDraftReceipts, buildDraftReceiptBlocks };
