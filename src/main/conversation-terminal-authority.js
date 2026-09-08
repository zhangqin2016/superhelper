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

module.exports = { preserveHostInterruption };
