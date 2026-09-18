"use strict";

/**
 * Prompts the platform sends to ITSELF.
 *
 * Provenance cannot be recovered downstream. The engine is a separate process
 * that carries text and nothing else, so by the time a continuation comes back
 * as a message there is no way to tell it from something the user typed except
 * by reading the words. That is how it was done before — one hard-coded English
 * sentence, matched by one consumer on the reload path — and of the three places
 * the platform nudged itself, two sent bare text. Their questions surfaced in
 * the conversation as if the user had asked them.
 *
 * So the stamp goes on at the moment of sending, where the caller knows exactly
 * what it is composing. This module is that one moment;
 * `scripts/test-internal-prompt-provenance.mjs` holds the rule that keeps it
 * the only one.
 *
 * What must NEVER come through here is text the user typed: the pending
 * payload, a steer, and the retries that re-deliver the same request after an
 * engine rebuild are all the user's own words, and stamping them would hide the
 * user's message from their own conversation.
 *
 * The default kind is `recovery`, never `self_check`: a recovery hides the
 * platform's question and KEEPS the model's answer, because that answer is the
 * work the user asked for. A prompt whose answer really is scaffolding has to
 * say so explicitly. [gate: internal-prompt-provenance]
 */

const { INTERNAL_PROMPT_KINDS, markInternalPrompt } = require("./internal-prompt-marker");

/**
 * @param {{ _server: object, spawnOptions?: object }} session
 * @param {{ text: string, kind?: string }} input
 * @returns {Promise<boolean>} whether anything was sent
 */
async function sendPlatformPrompt(session, { text, kind = INTERNAL_PROMPT_KINDS.RECOVERY } = {}) {
  if (!session?._server || !text) return false;
  await session._server.sendPrompt({
    text: markInternalPrompt(text, kind),
    files: [],
    guidance: session.spawnOptions?.guidance || "",
  });
  return true;
}

/**
 * Send a corrective nudge without awaiting it, settling the turn if it cannot land.
 *
 * Every caller had written this out: an async IIFE, a try/catch, a warning, and
 * "if the turn is still open, settle it on the original result rather than hang".
 * That last clause is the one that matters — a nudge that never arrives must not
 * leave the turn waiting forever — so it belongs here, once, rather than in each
 * gate's copy of the boilerplate.
 *
 * @param {object} session
 * @param {{ text: string, kind?: string, reason: string, settlePayload?: object, log: object }} input
 */
function nudgePlatformPrompt(session, { text, kind, reason, settlePayload, log } = {}) {
  void (async () => {
    try {
      await sendPlatformPrompt(session, { text, kind });
    } catch (error) {
      log?.warn?.("%s failed: %s", reason, error?.message || String(error));
      if (session?.busy && !session?._turnSettled) session._settleTurn?.(settlePayload);
    }
  })();
}

module.exports = { INTERNAL_PROMPT_KINDS, nudgePlatformPrompt, sendPlatformPrompt };
