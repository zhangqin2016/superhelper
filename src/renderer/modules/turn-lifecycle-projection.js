import { appendTimelineNotice } from "./turn-notice-timeline.js";
import { closeStreamingBlocks } from "./turn-streaming-blocks.js";

// Small non-terminal turn-lifecycle projections for the runtime store.

// turn.paused (principal switch mid-preflight): the main process kept the
// durable admission resumable — the SAME turnId is revived by a later
// re-dispatch whose turn.started reuses this live turn. Close the live
// projection so the composer unblocks instead of spinning on a turn that is
// no longer running.
export function applyTurnPaused(runtime, live, event) {
  live.phase = "paused";
  closeStreamingBlocks(live, event.ts || Date.now());
  appendTimelineNotice(live, {
    code: "turnPaused",
    level: "info",
  }, event.ts || Date.now());
  runtime.phase = "idle";
  runtime.turnId = null;
  runtime._turnStartedAt = 0;
}

// turn.steered: the user injected a message into the CURRENT turn.
export function applyTurnSteered(live, event) {
  appendTimelineNotice(live, {
    code: "turnSteered",
    level: "info",
    detail: event.payload?.text ? String(event.payload.text).trim() : "",
  }, event.ts || Date.now());
}
