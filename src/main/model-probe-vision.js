"use strict";

const requestShape = require("./openai-request-shape");
const { trimUrl, mergeBody } = require("./model-probe-http");

// A 1x1 red PNG (67 bytes). Sent as an image content part to ask whether the
// endpoint accepts multimodal input for this model. A model that rejects images
// answers 400 naming image/vision; one that accepts it answers 200. Learned from
// the server, never assumed from the model name. Kill switch: LILY_PROBE_VISION=0.
const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
    // Accepted the image → vision. A 4xx that names image/vision → not vision.
    // Any other failure (network, unrelated 4xx) → fail-open: don't claim vision.
    return Boolean(sent.ok);
  } catch {
    return false;
  }
}

module.exports = { probeVision, TINY_PNG_DATA_URL };
