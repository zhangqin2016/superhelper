"use strict";

/**
 * Read a streamed model reply, judging it by whether it is still producing
 * output — never by how long it has taken.
 *
 * A fixed deadline on a model call measures the model's speed and calls it a
 * fault. On a company gateway that writes 18 tokens a second (measured over
 * 471 replies, 2026-09-24), an audit that has to write a verdict with verbatim
 * quotes needs about a minute; every fixed bound anyone had picked for it —
 * 10s, then 30s — would have failed it for being slow while it was working
 * correctly. A reply that is still arriving is alive, however slowly.
 *
 * So two bounds, both about liveness:
 *   - first output: a large prompt takes a while to read before the first token;
 *   - stall: once output has begun, a gap with nothing new means it stopped.
 * There is no total bound. The output budget (max tokens) already caps length,
 * and a caller that must not wait is expected not to be waiting on this.
 *
 * Handles Chat Completions chunks and Responses events, and reads text and
 * reasoning separately — a thinking model may write its verdict in either.
 * (Anthropic's stream shares its event names with the legacy engine wire the
 * runtime-boundary ratchet confines to the adapter layer, so that protocol is read
 * non-streamed by the caller instead.)
 */

const DEFAULT_FIRST_OUTPUT_MS = 120_000;
const DEFAULT_STALL_MS = 60_000;

function liveness(env = process.env) {
  const positive = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const stallMs = positive(env?.LILY_MODEL_STALL_MS, DEFAULT_STALL_MS);
  return { firstOutputMs: Math.max(positive(env?.LILY_MODEL_FIRST_OUTPUT_MS, DEFAULT_FIRST_OUTPUT_MS), stallMs), stallMs };
}

/** Text and reasoning a single SSE `data:` payload adds, in either dialect. */
function deltaOf(event) {
  if (!event || typeof event !== "object") return { text: "", reasoning: "", done: false };
  const type = typeof event.type === "string" ? event.type : "";
  if (type.startsWith("response.")) {
    if (type === "response.output_text.delta") return { text: String(event.delta || ""), reasoning: "", done: false };
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      return { text: "", reasoning: String(event.delta || ""), done: false };
    }
    return { text: "", reasoning: "", done: type === "response.completed" };
  }
  const chunk = require("./chat-completion-reply").streamDelta(event);
  return { text: chunk.content, reasoning: chunk.reasoning, done: Boolean(chunk.finishReason) };
}

/**
 * @param {Response} response   an OK streaming response
 * @param {{ firstOutputMs?: number, stallMs?: number, startedAt?: number, abort?: () => void, now?: () => number }} [options]
 *   `startedAt` is when the REQUEST was sent: a gateway that holds its headers
 *   until the first token has already spent part of the first-output window.
 * @returns {Promise<{ ok: boolean, text: string, reasoning: string, reason: string,
 *   firstOutputAfterMs: number|null, totalMs: number }>}
 */
async function readModelStream(response, options = {}) {
  const bounds = liveness();
  const firstOutputMs = Number(options.firstOutputMs) || bounds.firstOutputMs;
  const stallMs = Number(options.stallMs) || bounds.stallMs;
  const now = options.now || (() => Date.now());
  const started = Number(options.startedAt) || now();
  let text = "";
  let reasoning = "";
  let firstOutputAt = null;
  let reason = "";
  const reader = response?.body?.getReader?.();
  if (!reader) return { ok: false, text, reasoning, reason: "no_stream_body", firstOutputAfterMs: null, totalMs: 0 };

  let timer = null;
  let stalled = null;
  const arm = () => {
    clearTimeout(timer);
    const waitMs = firstOutputAt === null ? Math.max(0, firstOutputMs - (now() - started)) : stallMs;
    timer = setTimeout(() => {
      stalled = firstOutputAt === null
        ? `no_output_within_${firstOutputMs}ms`
        : `stalled_${stallMs}ms_after_${text.length + reasoning.length}_chars`;
      try { options.abort?.(); } catch { /* the reader rejects either way */ }
      reader.cancel?.().catch?.(() => {});
    }, waitMs);
    timer.unref?.();
  };

  const decoder = new TextDecoder();
  let buffered = "";
  let finished = false;
  arm();
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || "";
      let progressed = false;
      for (const line of lines) {
        const trimmed = line.trim();
        // SSE comments (": ping") keep a connection open; they are not the
        // model producing anything, so they do not count as liveness.
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") { finished = true; break; }
        let event = null;
        try { event = JSON.parse(data); } catch { continue; }
        const delta = deltaOf(event);
        if (delta.text || delta.reasoning) {
          text += delta.text;
          reasoning += delta.reasoning;
          if (firstOutputAt === null) firstOutputAt = now();
          progressed = true;
        }
        if (delta.done) finished = true;
      }
      if (progressed) arm();
    }
  } catch (error) {
    reason = stalled || `stream_error:${error?.message || error}`;
  } finally {
    clearTimeout(timer);
    // A reply that signalled its end may leave trailing frames; release the socket.
    if (finished) reader.cancel?.().catch?.(() => {});
  }
  if (!reason && stalled) reason = stalled;
  return {
    ok: !reason,
    text,
    reasoning,
    reason,
    firstOutputAfterMs: firstOutputAt === null ? null : firstOutputAt - started,
    totalMs: now() - started,
  };
}

// A non-streamed reply has no liveness to watch, only an end. For a caller that
// no longer holds the answer this ceiling exists so a dead connection is
// released — it is not a judgement of the model's speed.
const NON_STREAM_CEILING_MS = 10 * 60 * 1000;

module.exports = { DEFAULT_FIRST_OUTPUT_MS, DEFAULT_STALL_MS, NON_STREAM_CEILING_MS, liveness, readModelStream };
