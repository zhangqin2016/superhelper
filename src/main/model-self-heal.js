"use strict";

/**
 * Runtime model self-heal.
 *
 * When a turn dies with a failure signature that a fresh compatibility probe
 * can explain (e.g. the gateway returned an error page instead of model
 * output, so the engine saw an empty completion), force a re-probe of the
 * ACTIVE custom model, persist the updated profile, and report whether the
 * profile actually changed so the orchestrator can retry the turn silently.
 *
 * Capability-gate guard rails:
 * - fail-open: any internal error returns { attempted: false } and leaves the
 *   normal failure flow untouched
 * - evidence-gated: only healable failure codes trigger it, and only custom
 *   openai presets with their own connection are ever probed (repair() skips
 *   everything else)
 * - single-flight + per-preset cooldown: concurrent or repeating failures
 *   cannot stampede the gateway with probes or retry-loop forever
 * - kill switch: LILY_ENABLE_MODEL_SELF_HEAL=0
 */

const { getLogger } = require("./logger");

const log = getLogger("model-self-heal");

// Failure signatures a re-probe can plausibly explain and fix. Keep this list
// tight: adding a code here means "a compatibility profile change might fix
// it", not "the turn failed".
const HEALABLE_CODES = Object.freeze(new Set([
  // Engine finished cleanly with zero output — the classic gateway-error-page
  // / thinking-swallowed-output / tool-shape-rejection signature.
  "EMPTY_ASSISTANT_COMPLETION",
  // The model leaked a tool-call fragment as text — often a tool-call format
  // mismatch a re-probe can reclassify.
  "MALFORMED_TOOL_CALL_TEXT",
  // The engine surfaced an explicit empty/invalid/unparseable response — the
  // runtime signature of the probe's MODEL_STREAMING_NO_CONTENT family (a
  // gateway that answers non-stream fine but streams nothing, or returns an
  // error page instead of SSE). A re-probe re-measures exactly that.
  "RESPONSE_ERROR",
  // Mid-turn stream truncation (final finish reason "unknown" after healthy
  // ones) — same flaky-stream gateway family; a re-probe re-measures it.
  "TRUNCATED_TURN_END",
]));

const COOLDOWN_MS = 10 * 60_000;

const cooldownByPreset = new Map();
let inFlight = null;

function selfHealEnabled() {
  return process.env.LILY_ENABLE_MODEL_SELF_HEAL !== "0";
}

function isHealableFailureCode(code) {
  return HEALABLE_CODES.has(String(code || ""));
}

/**
 * @returns {Promise<{attempted: boolean, healed?: boolean, reason?: string, errors?: Array}>}
 */
async function attemptModelSelfHeal({ code, systemPromptProbeText = "", now = Date.now() } = {}) {
  try {
    if (!selfHealEnabled()) return { attempted: false, reason: "disabled" };
    if (!isHealableFailureCode(code)) return { attempted: false, reason: "code_not_healable" };
    const presets = require("./model-presets");
    const presetId = String(presets.getActivePresetId() || "");
    const last = cooldownByPreset.get(presetId) || 0;
    if (now - last < COOLDOWN_MS) return { attempted: false, reason: "cooldown" };
    if (inFlight) return inFlight;
    inFlight = (async () => {
      cooldownByPreset.set(presetId, now);
      log.info(`self-heal probe start: preset=${presetId || "-"} trigger=${code}`);
      const result = await presets.repairCustomPresetCompatibilityProfiles({
        activeOnly: true,
        force: true,
        systemPromptProbeText,
        timeoutMs: 15_000,
      });
      const healed = Number(result?.changedCount || 0) > 0;
      log.info(
        `self-heal probe done: preset=${presetId || "-"} repaired=${result?.repairedCount || 0} changed=${result?.changedCount || 0}`
        + (result?.errors?.length ? ` errors=${JSON.stringify(result.errors)}` : ""),
      );
      return { attempted: true, healed, errors: result?.errors || [] };
    })().finally(() => {
      inFlight = null;
    });
    return await inFlight;
  } catch (err) {
    log.warn(`self-heal failed open: ${err?.message || String(err)}`);
    return { attempted: false, reason: "error", error: err?.message || String(err) };
  }
}

/** Test hook: reset in-memory cooldowns. */
function resetSelfHealStateForTests() {
  cooldownByPreset.clear();
  inFlight = null;
}

module.exports = {
  attemptModelSelfHeal,
  isHealableFailureCode,
  resetSelfHealStateForTests,
};
