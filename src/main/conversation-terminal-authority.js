"use strict";

// Native abort/error is a transport observation, not authority to rewrite a
// committed host cancellation. Keep empty interrupted answers deduplicable too.
function preserveHostInterruption(merged, local) {
  if (local.record?.terminal !== "turn.interrupted" || merged.role !== "assistant") return merged;
  merged.failed = false;
  merged.record.terminal = "turn.interrupted";
  merged.record.turnId = local.turnId || local.record.turnId;
  merged.record.tools = local.record.tools || merged.record.tools;
  merged.record.meta = { ...merged.record.meta, terminal: "turn.interrupted", interrupted: true, failed: false };
  return merged;
}

function preserveHostRecovery(merged, local) {
  const terminal = local.record?.terminal;
  if (merged.role !== "assistant" || !["turn.dispatch_outcome_unknown", "turn.dispatch_blocked"].includes(terminal)) return merged;
  const explanation = String(local.content || local.record?.assistantText || "").trim();
  const existing = String(merged.content || merged.record?.assistantText || "").trim();
  const text = explanation && !existing.includes(explanation)
    ? [existing, explanation].filter(Boolean).join("\n\n") : existing;
  merged.content = text;
  merged.failed = true;
  merged.record = {
    ...(merged.record || {}),
    terminal,
    assistantText: text,
    meta: { ...(merged.record?.meta || {}), ...local.record.meta, terminal, failed: true },
  };
  merged.meta = { ...(merged.meta || {}), ...local.meta, terminal };
  return merged;
}

module.exports = { preserveHostInterruption, preserveHostRecovery };
