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

// Built from the shared contract like every other placeholder Lily puts in
// history. This one stands in for content that never existed rather than content
// that was removed, but the rule the model must follow is the same: it is not
// material, and it must never become the body of a file.
import elision from "./lib/history-elision.cjs";

const REPAIR_MARKER = elision.elide({
  what: "an assistant turn with no provider-visible response",
  why: "because the provider returned nothing to store",
  action: "Treat it as an empty turn and continue from the user's request.",
});

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
