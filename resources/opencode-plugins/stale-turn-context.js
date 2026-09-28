// Earlier turns' instructions do not follow the conversation forward.
//
// Before every model call (turn and compaction alike), each user message that
// is HISTORY is reduced to what is true about it — the user's request, what
// they attached and the extracted content — dropping the task contract,
// memory and bootstrap context that were meant for that turn only. See
// lib/stale-turn-layers.cjs for why, and for what is kept.
//
// "History" = every layered user message before the LAST layered one. The last
// layered message is the current turn's request; platform prompts inside the
// same turn (a todo continuation, a correction) carry no layers, so they never
// make the current turn's own contract look stale.
//
// Operates on the per-call copy the engine hands to the transform; stored
// history is untouched. FAIL OPEN: never throws. Kill switch:
// LILY_STALE_TURN_CONTEXT=0.
//
// NOTE: only the plugin factory is exported — the OpenCode loader instantiates
// every export as a plugin factory.

import layers from "./lib/stale-turn-layers.cjs";

function layeredTextParts(message) {
  if (message?.info?.role !== "user" || !Array.isArray(message.parts)) return [];
  return message.parts.filter((part) => part?.type === "text" && layers.isLayeredRequest(part.text));
}

export const StaleTurnContextPlugin = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      if (process.env.LILY_STALE_TURN_CONTEXT === "0") return;
      const messages = output && Array.isArray(output.messages) ? output.messages : null;
      if (!messages) return;
      let current = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (layeredTextParts(messages[i]).length) { current = i; break; }
      }
      if (current <= 0) return;
      for (let i = 0; i < current; i += 1) {
        for (const part of layeredTextParts(messages[i])) part.text = layers.stripStaleTurnLayers(part.text);
      }
    } catch {
      /* fail open — history reaches the model exactly as stored */
    }
  },
});

export default StaleTurnContextPlugin;
