// Earlier turns' instructions do not follow the conversation forward.
//
// Before every model call (turn and compaction alike), each user message that
// is HISTORY is reduced to what is true about it — the user's request, what
// they attached and the extracted content — dropping the task contract,
// memory and bootstrap context that were meant for that turn only. See
// lib/stale-turn-layers.cjs for why, and for what is kept.
//
// "History" = every layered user message before the one that OPENED the current
// turn (lib opensTurn): a steer sent mid-turn and an internal recovery
// continuation belong to the running turn, so they never make its own contract
// look stale; platform prompts (a todo continuation) carry no layers at all.
// A turn that carried no instructions of its own (a bare "谢谢") opens nothing,
// so the earlier request stays whole — exactly as before this plugin.
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
      for (let i = messages.length - 1; i >= 0 && current < 0; i -= 1) {
        if (layeredTextParts(messages[i]).some((part) => layers.opensTurn(part.text))) current = i;
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
