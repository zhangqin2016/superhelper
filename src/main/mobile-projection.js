"use strict";

// Pure mapper: a desktop RuntimeEvent → a compact frame projected to the paired
// phone over the relay (so the phone SEES the turn it triggered, not just an
// admit ack). Kept pure + tiny so the phone renders a lightweight view: turn
// lifecycle + streaming assistant text + a hint of tool activity. Returns null
// for events the phone doesn't need (most of them), so the relay stays quiet.
//
// The phone's contract:
//   turn.started  → clear the reply buffer, show "运行中"
//   assistant.delta → append text
//   tool.started  → show a one-line "正在使用 <tool>" hint
//   turn.ended    → mark done/failed/interrupted
//
// Frames are additive projections; they never carry secrets (no tool inputs,
// no file contents) — just text the desktop already shows the local user.

const TERMINAL_STATUS = {
  "turn.completed": "completed",
  "turn.failed": "failed",
  "turn.interrupted": "interrupted",
  "turn.stalled": "stalled",
};

/** Extract readable text from an assistant.final payload's message object. */
function assistantText(assistant) {
  if (!assistant || typeof assistant !== "object") return "";
  if (typeof assistant.text === "string") return assistant.text;
  if (typeof assistant.content === "string") return assistant.content;
  if (Array.isArray(assistant.content)) {
    return assistant.content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

function mobileProjectionFrame(event) {
  if (!event || typeof event !== "object") return null;
  const turnId = event.turnId || null;
  const payload = event.payload || {};
  switch (event.type) {
    case "turn.started":
      return { type: "turn.started", turnId };
    case "assistant.delta": {
      const text = String(payload.text || "");
      return text ? { type: "assistant.delta", turnId, text } : null;
    }
    case "assistant.final": {
      // Only useful when there were no deltas (some engines emit final only);
      // the phone treats it as the authoritative text if present.
      const text = assistantText(payload.assistant);
      return text ? { type: "assistant.final", turnId, text } : null;
    }
    case "tool.started": {
      const tool = String(payload.name || payload.tool || payload.title || "").slice(0, 60);
      return tool ? { type: "tool.started", turnId, tool } : null;
    }
    default: {
      const status = TERMINAL_STATUS[event.type];
      return status ? { type: "turn.ended", turnId, status } : null;
    }
  }
}

module.exports = { mobileProjectionFrame, TERMINAL_STATUS };
