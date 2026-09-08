"use strict";

// References only: raw user text stays in the existing owner-scoped admission.
const MAX_TURNS = 32;
function normalizeRequestSource(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.turnIds)) return null;
  const valid = item => typeof item === "string" && item.length > 0 && item.length <= 160;
  if (![value.sessionId, value.ownerScope].every(valid) || !value.turnIds.every(valid)) return null;
  return { schemaVersion: 1, sessionId: value.sessionId, ownerScope: value.ownerScope,
    projectId: typeof value.projectId === "string" ? value.projectId.slice(0, 160) : "",
    turnIds: [...new Set(value.turnIds)].slice(0, MAX_TURNS),
    complete: value.complete === true && value.turnIds.length <= MAX_TURNS };
}

function bindTaskRequest({ manager, session, taskContract, turnId, text }) {
  if (!taskContract?.active || !taskContract.intentContract || !turnId) return null;
  const intent = taskContract.intentContract;
  const inherited = ["continue", "refine", "correct"].includes(intent.relation);
  const previous = normalizeRequestSource(intent.requestSource);
  let owner;
  try { owner = manager?.resolveTurnOwnerScope?.(session.id); } catch { /* optional source unavailable */ }
  const fallback = { text: String(text || ""), complete: !inherited, reason: "request_source_unavailable" };
  if (!owner?.ok || !owner.ownerScope) return inherited ? fallback : null;
  const sameScope = previous && previous.sessionId === session.id && previous.ownerScope === owner.ownerScope
    && previous.projectId === String(session.projectId || "");
  const turnIds = inherited && sameScope ? [...previous.turnIds] : [];
  if (!turnIds.includes(turnId)) turnIds.push(turnId);
  const source = normalizeRequestSource({ schemaVersion: 1, sessionId: session.id, ownerScope: owner.ownerScope,
    projectId: String(session.projectId || ""), turnIds,
    complete: !inherited || Boolean(sameScope && previous.complete) });
  intent.requestSource = source;
  if (!source) return fallback;
  let complete = source.complete;
  const instructions = [];
  for (const id of source.turnIds) {
    if (id === turnId) { instructions.push(String(text || "")); continue; }
    try {
      const input = manager.getTurnInputByTurnId?.(session.id, id);
      if (!input || input.sessionId !== session.id || input.turnId !== id || input.ownerScope !== owner.ownerScope
        || (input.taskCore?.projectId && input.taskCore.projectId !== source.projectId)
        || typeof input.userText !== "string") { complete = false; continue; }
      instructions.push(input.userText);
    } catch { complete = false; }
  }
  if (!source.turnIds.includes(turnId)) instructions.push(String(text || ""));
  return { text: instructions.join("\n\nSubsequent user instruction (later instructions supersede earlier ones):\n"),
    complete, reason: complete ? null : "request_source_incomplete" };
}

module.exports = { bindTaskRequest, normalizeRequestSource };
