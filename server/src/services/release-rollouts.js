/**
 * A rollout's life, decided once: which transitions exist and what each one
 * requires. Pure — the admin routes apply the result and audit it.
 *
 *   draft ─start(p)─▶ rolling ─raise(q>p)─▶ rolling ─complete─▶ complete
 *                       │  ▲
 *                     pause resume
 *                       ▼  │
 *                     paused ─halt─▶ halted ─(reopen)─▶ paused
 *
 * The percentage only goes up: lowering it would not take the version back
 * from devices that already installed it, so "fewer devices" is spelled
 * pause or halt. complete is 100% and final; a newer rollout supersedes it.
 */

export const ROLLOUT_STATES = ["draft", "rolling", "paused", "halted", "complete"];
export const ROLLOUT_ACTIONS = ["start", "raise", "pause", "resume", "halt", "reopen", "complete"];

const FROM = {
  start: ["draft"],
  raise: ["rolling", "paused"],
  pause: ["rolling"],
  resume: ["paused"],
  halt: ["draft", "rolling", "paused"],
  reopen: ["halted"],
  complete: ["rolling", "paused"],
};

function refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * @param {{ state: string, percent: number, immutable_feed?: boolean }} rollout current row (+ its release's feed flag)
 * @param {{ action: string, percent?: number }} input
 * @param {{ otherActive?: { id: string, version: string } | null, now?: Date }} context
 *   otherActive: another rolling/paused rollout on the same channel × platform
 * @returns {{ ok: true, patch: object } | { ok: false, code: string, message: string }}
 */
export function transitionRollout(rollout, input, context = {}) {
  const action = String(input?.action || "");
  if (!ROLLOUT_ACTIONS.includes(action)) return refuse("ROLLOUT_ACTION_UNKNOWN", `Unknown action "${action}".`);
  if (!FROM[action].includes(rollout.state)) {
    return refuse("ROLLOUT_TRANSITION_INVALID", `Cannot ${action} a rollout that is ${rollout.state}.`);
  }
  const now = context.now || new Date();
  const current = Number(rollout.percent) || 0;

  if (action === "start" || action === "raise") {
    const percent = Number(input.percent);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      return refuse("ROLLOUT_PERCENT_INVALID", "percent must be an integer between 1 and 100.");
    }
    if (action === "raise" && percent <= current) {
      return refuse("ROLLOUT_PERCENT_NOT_HIGHER", `A rollout only widens: ${percent}% is not above the current ${current}%. Pause or halt it to stop it.`);
    }
    if (percent < 100 && !rollout.immutable_feed) {
      // Without its own feed a device in the slice would be pointed at stable/,
      // which still holds the previous version: the rollout would reach no one.
      return refuse("ROLLOUT_NEEDS_IMMUTABLE_FEED", "A partial rollout needs the release's own auto-update feed (published with --rollout by release-one-click). Publish it at 100% instead, or republish it.");
    }
    if (action === "start" && context.otherActive) {
      return refuse("ROLLOUT_ALREADY_ACTIVE", `${context.otherActive.version} is already rolling on this channel and platform. Complete or halt it first.`);
    }
    if (percent === 100) return { ok: true, patch: { state: "complete", percent: 100, completed_at: now, ...(action === "start" ? { started_at: now } : {}) } };
    return { ok: true, patch: { state: "rolling", percent, ...(action === "start" ? { started_at: now } : {}) } };
  }
  if (action === "pause") return { ok: true, patch: { state: "paused" } };
  if (action === "resume") return { ok: true, patch: { state: "rolling" } };
  if (action === "halt") return { ok: true, patch: { state: "halted", halted_at: now } };
  if (action === "reopen") {
    if (context.otherActive) return refuse("ROLLOUT_ALREADY_ACTIVE", `${context.otherActive.version} is active on this channel and platform.`);
    return { ok: true, patch: { state: "paused", halted_at: null } };
  }
  if (action === "complete") return { ok: true, patch: { state: "complete", percent: 100, completed_at: now } };
  return refuse("ROLLOUT_ACTION_UNKNOWN", `Unknown action "${action}".`);
}
