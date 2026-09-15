"use strict";

/**
 * The task anchor a mid-turn compaction must not lose: the turn's original
 * request and its acceptance contract. Written into the compaction handoff
 * file at turn start (see compaction-memory-refresh.js) and re-attached by the
 * compaction-continuity plugin after the engine summarizes. Pure and bounded.
 */

const MAX_REQUEST_CHARS = 600;
const MAX_ITEMS = 6;
const MAX_ITEM_CHARS = 160;

function clip(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function items(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => clip(typeof item === "string" ? item : item?.title || item?.text || item?.path || "", MAX_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function buildCompactionAnchor(state = {}, rawText = "") {
  try {
    const acceptance = require("./task-original-acceptance").originalAcceptance({
      ...state,
      enginePayload: state.enginePayload || { rawText },
    });
    const request = clip(rawText || acceptance.objective, MAX_REQUEST_CHARS);
    const anchor = {
      request,
      successCriteria: items(acceptance.successCriteria),
      deliverables: items(acceptance.deliverables),
    };
    return anchor.request || anchor.successCriteria.length || anchor.deliverables.length ? anchor : null;
  } catch {
    return rawText ? { request: clip(rawText, MAX_REQUEST_CHARS), successCriteria: [], deliverables: [] } : null;
  }
}

module.exports = { buildCompactionAnchor, MAX_REQUEST_CHARS };
