"use strict";

const requestShape = require("./openai-request-shape");
const { trimUrl, mergeBody } = require("./model-probe-http");

// A 1x1 red PNG (69 bytes). Sent as an image content part to ask whether the
// endpoint accepts multimodal input for this model. A model that rejects images
// answers 400 naming image/vision; one that accepts it answers 200. Learned from
// the server, never assumed from the model name. Kill switch: LILY_PROBE_VISION=0.
//
// This image MUST be a structurally valid PNG — every chunk CRC correct and IEND
// present. The previous constant was truncated with a wrong IDAT checksum, which
// lenient decoders accepted and strict ones rejected with "the image data you
// provided does not represent a valid image" (2026-09-19: a real endpoint whose
// models read images fine was probed as vision:false, so every image on that
// preset lost the native path). test-model-vision-capability.mjs decodes it.
const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN4oKAAAAMEASFZiW1LAAAAAElFTkSuQmCC";

async function probeVision({ baseUrl, apiKey, model, bodyOverlay = null, timeoutMs = 10_000 }) {
  if (process.env.LILY_PROBE_VISION === "0") return false;
  try {
    const sent = await requestShape.sendChatCompletion({
      url: `${trimUrl(baseUrl)}/chat/completions`,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: mergeBody({ model, messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
        { type: "text", text: "Reply with the single word: ok" },
      ] }] }, bodyOverlay && typeof bodyOverlay === "object" ? bodyOverlay : null),
      maxTokens: 16,
      shape: requestShape.recallShape(baseUrl, model),
      timeoutMs,
      onAdapt: (shape) => requestShape.rememberShape(baseUrl, model, shape),
    });
    // Accepted the image AND answered with a completion → vision. A 4xx that
    // names image/vision → not vision. Any other failure (network, unrelated
    // 4xx) → fail-open: don't claim vision. The status alone is not the verdict:
    // a gateway that answers 200 with an HTML error page or an error envelope
    // did not read the image (same class as the vision-bridge regression).
    return Boolean(sent.ok) && require("./chat-completion-reply").isChatCompletion(sent.json);
  } catch {
    return false;
  }
}

module.exports = { probeVision, TINY_PNG_DATA_URL };
