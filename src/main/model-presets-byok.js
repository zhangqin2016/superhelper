"use strict";

/**
 * The BYOK (own model key) plan gate as model-presets applies it. The verdict
 * itself is byok-policy's (via account-manager); this module only turns it into
 * preset behaviour: refuse adding/choosing a custom model, resolve the active
 * model past a locked one (the stored choice is kept, so the lock lifts by
 * itself), and announce a lock once per episode. Fail-open throughout.
 */
const fs = require("node:fs");

const BYOK_NOTICE_FILE = "byok-lock-notice.json";

function createPresetByokGate({ loadUserChoice, getCustomPresets, userDataPath, readJson, writeJson }) {
  function decision() {
    try {
      return require("./account-manager").byokDecision();
    } catch {
      return require("./byok-policy").decideByok({});
    }
  }

  /** { ok:false, error:"BYOK_PLAN_REQUIRED" } when the plan gate refuses a custom model, else null. */
  function refusal() {
    const verdict = decision();
    return verdict.allowed ? null : { ok: false, error: "BYOK_PLAN_REQUIRED", byok: verdict };
  }

  /** The presets the active model may resolve among: a locked custom choice is as if absent. */
  function resolvablePresets(presets, selectedId) {
    if (presets.some((p) => p.custom && p.id === selectedId) && !decision().allowed) return presets.filter((p) => !p.custom);
    return presets;
  }

  function lockedActiveCustomPreset() {
    const selectedId = loadUserChoice()?.activePresetId;
    const preset = getCustomPresets().find((p) => p.id === selectedId);
    if (!preset || decision().allowed) return null;
    // Same id the model picker uses, so one model is announced once, not twice.
    return { id: require("./model-identity").canonicalModelId(preset.id, preset.model), label: preset.label };
  }

  /** One-shot notice for chosen models the gate now locks; the record clears once BYOK is allowed. */
  function takeSwitchNotice(candidates = [lockedActiveCustomPreset()]) {
    try {
      const file = userDataPath(BYOK_NOTICE_FILE);
      const verdict = decision();
      if (verdict.allowed) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return null;
      }
      const seen = new Set(readJson(file, {})?.notifiedIds || []);
      const fresh = (Array.isArray(candidates) ? candidates : []).filter((c) => c?.id && !seen.has(c.id));
      if (!fresh.length) return null;
      writeJson(file, { notifiedIds: [...seen, ...fresh.map((c) => c.id)] });
      return { models: fresh.map((c) => String(c.label || c.id)), pricingUrl: verdict.pricingUrl };
    } catch {
      return null;
    }
  }

  return { decision, refusal, resolvablePresets, takeSwitchNotice };
}

module.exports = { createPresetByokGate, BYOK_NOTICE_FILE };
