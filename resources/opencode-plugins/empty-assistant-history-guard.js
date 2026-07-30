// Repair persisted assistant messages that have no provider-visible content.
//
// A stopped/interrupted turn can leave an assistant row with no text or tool
// part in OpenCode history. Strict OpenAI-compatible providers reject every
// later request containing that row before the model or any tool can run. The
// messages transform runs before both ordinary and compaction model calls, so
// adding one neutral text part here also self-heals existing conversations.
//
// Tool messages are never changed because dropping or rewriting them could
// break tool-call/result pairing. Healthy text history passes through exactly
// as stored. Kill switch: LILY_EMPTY_ASSISTANT_HISTORY_GUARD=0.
//
// Only the plugin factory is exported: OpenCode instantiates every export.

const REPAIR_MARKER = "[lily: previous assistant turn contained no provider-visible response]";

function isAssistant(message) {
  return (message?.info?.role || message?.role) === "assistant";
}

function hasVisibleText(parts) {
  return parts.some(
    (part) =>
      part?.type === "text" &&
      !part.ignored &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  );
}

function hasToolPart(parts) {
  return parts.some((part) => part?.type === "tool");
}

function hasRepairMarker(parts) {
  return parts.some(
    (part) => part?.type === "text" && part.text === REPAIR_MARKER,
  );
}

export const EmptyAssistantHistoryGuardPlugin = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      if (process.env.LILY_EMPTY_ASSISTANT_HISTORY_GUARD === "0") return;
      const messages = Array.isArray(output?.messages) ? output.messages : null;
      if (!messages) return;

      for (const message of messages) {
        if (!isAssistant(message) || !Array.isArray(message.parts)) continue;
        if (
          hasVisibleText(message.parts) ||
          hasToolPart(message.parts) ||
          hasRepairMarker(message.parts)
        ) {
          continue;
        }
        message.parts.push({ type: "text", text: REPAIR_MARKER });
      }
    } catch {
      /* fail open: history repair must never break a model call */
    }
  },
});

export default EmptyAssistantHistoryGuardPlugin;
