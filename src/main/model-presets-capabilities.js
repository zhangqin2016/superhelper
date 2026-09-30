"use strict";

// What the ACTIVE model can take as input, read from its preset's declared
// capabilities. Split out of model-presets.js (size ratchet); behaviour unchanged.

function createActivePresetCapabilities(getActivePreset) {
  /**
   * Whether the active model natively recognizes images. When true the vision
   * preflight skips the Qwen bridge and lets images pass through as image blocks.
   */
  function activePresetSupportsVision() {
    try {
      return Boolean(getActivePreset()?.capabilities?.vision);
    } catch {
      // Capability probe must never crash a turn; if presets can't be resolved
      // (e.g. paths not bound yet), assume no native vision → use the bridge.
      return false;
    }
  }
  
  /**
   * The non-image file-part media types the active model is DECLARED to accept as
   * raw file parts (e.g. an Anthropic-family managed model that takes
   * "application/pdf"). This is opt-in per preset via `capabilities.filePartMimes`
   * — there is no safe default because arbitrary custom/BYOK models reject file
   * parts they don't understand (the AI SDK throws AI_UnsupportedFunctionalityError
   * while building the request). So the default is EMPTY: non-image attachments go
   * as inline text or a source path (universally supported), never as a raw file
   * part, unless a preset explicitly says the model supports the type. Images stay
   * governed by `capabilities.vision` (activePresetSupportsVision), not this list.
   */
  function activePresetFilePartMimes() {
    try {
      const mimes = getActivePreset()?.capabilities?.filePartMimes;
      if (!Array.isArray(mimes)) return [];
      return mimes.map((m) => String(m || "").trim().toLowerCase()).filter(Boolean);
    } catch {
      return [];
    }
  }

  return { activePresetSupportsVision, activePresetFilePartMimes };
}

module.exports = { createActivePresetCapabilities };
