"use strict";

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function mergeBody(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeBody(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function messageShape(json) {
  const message = json?.choices?.[0]?.message || {};
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning === "string" ? message.reasoning : "";
  return {
    hasContent: content.trim().length > 0,
    hasReasoning: reasoning.trim().length > 0,
  };
}

async function postChat({ baseUrl, apiKey, model, bodyOverlay = null, timeoutMs = 10_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("MODEL_PROBE_TIMEOUT")), Math.max(500, timeoutMs));
  const body = mergeBody({
    model,
    messages: [{ role: "user", content: "Say pong only." }],
    max_tokens: 16,
    stream: false,
  }, bodyOverlay);
  try {
    const response = await fetch(`${trimUrl(baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const BODY_OVERLAY_CANDIDATES = Object.freeze([
  {
    id: "disable-thinking",
    requestBodyOverlay: { chat_template_kwargs: { enable_thinking: false } },
  },
]);

async function probeCustomModelProfile({
  protocol,
  baseUrl,
  apiKey,
  model,
  timeoutMs = 10_000,
} = {}) {
  if (protocol && protocol !== "openai") {
    return { ok: true, profile: {}, diagnostics: { skipped: "non-openai-protocol" } };
  }
  const plain = await postChat({ baseUrl, apiKey, model, timeoutMs });
  if (!plain.ok) return { ok: false, error: plain.error || `HTTP_${plain.status || 0}` };
  const plainShape = messageShape(plain.json);
  if (plainShape.hasContent) {
    return { ok: true, profile: {}, diagnostics: { content: "plain" } };
  }

  for (const candidate of BODY_OVERLAY_CANDIDATES) {
    const repaired = await postChat({
      baseUrl,
      apiKey,
      model,
      bodyOverlay: candidate.requestBodyOverlay,
      timeoutMs,
    });
    if (!repaired.ok) continue;
    const repairedShape = messageShape(repaired.json);
    if (repairedShape.hasContent) {
      return {
        ok: true,
        profile: {
          requestBodyOverlay: candidate.requestBodyOverlay,
        },
        diagnostics: {
          content: "repaired",
          candidate: candidate.id,
          plainHadReasoning: plainShape.hasReasoning,
        },
      };
    }
  }

  return {
    ok: false,
    error: plainShape.hasReasoning ? "MODEL_REASONING_ONLY" : "MODEL_NO_CONTENT",
  };
}

module.exports = {
  probeCustomModelProfile,
};
