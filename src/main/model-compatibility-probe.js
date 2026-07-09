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

function streamShape(text) {
  let hasContent = false;
  let hasReasoning = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      const delta = json?.choices?.[0]?.delta || {};
      if (typeof delta.content === "string" && delta.content.trim()) hasContent = true;
      if (typeof delta.reasoning === "string" && delta.reasoning.trim()) hasReasoning = true;
    } catch {
      // Ignore malformed chunks; the caller handles no-content as failure.
    }
  }
  return { hasContent, hasReasoning };
}

async function postChat({ baseUrl, apiKey, model, bodyOverlay = null, stream = false, timeoutMs = 10_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("MODEL_PROBE_TIMEOUT")), Math.max(500, timeoutMs));
  const body = mergeBody({
    model,
    messages: [{ role: "user", content: "Say pong only." }],
    max_tokens: 16,
    stream: Boolean(stream),
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
    if (stream) return { ok: response.ok, status: response.status, shape: streamShape(text) };
    let json = null;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, shape: messageShape(json) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCandidate({ baseUrl, apiKey, model, bodyOverlay = null, timeoutMs }) {
  const nonStream = await postChat({ baseUrl, apiKey, model, bodyOverlay, timeoutMs });
  if (!nonStream.ok) return { ok: false, error: nonStream.error || `HTTP_${nonStream.status || 0}` };
  const stream = await postChat({ baseUrl, apiKey, model, bodyOverlay, stream: true, timeoutMs });
  if (!stream.ok) return { ok: false, error: stream.error || `HTTP_${stream.status || 0}`, nonStreamShape: nonStream.shape };
  return {
    ok: true,
    nonStreamShape: nonStream.shape,
    streamShape: stream.shape,
    hasContent: Boolean(nonStream.shape?.hasContent && stream.shape?.hasContent),
  };
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
  const plain = await probeCandidate({ baseUrl, apiKey, model, timeoutMs });
  if (!plain.ok) return { ok: false, error: plain.error };
  if (plain.hasContent) {
    return {
      ok: true,
      profile: {
        conformance: {
          chatCompletions: true,
          streaming: true,
          contentSource: "plain",
        },
      },
      diagnostics: { content: "plain", stream: "plain" },
    };
  }

  for (const candidate of BODY_OVERLAY_CANDIDATES) {
    const repaired = await probeCandidate({
      baseUrl,
      apiKey,
      model,
      bodyOverlay: candidate.requestBodyOverlay,
      timeoutMs,
    });
    if (!repaired.ok) continue;
    if (repaired.hasContent) {
      return {
        ok: true,
        profile: {
          requestBodyOverlay: candidate.requestBodyOverlay,
          conformance: {
            chatCompletions: true,
            streaming: true,
            contentSource: "body-overlay",
          },
        },
        diagnostics: {
          content: "repaired",
          stream: "repaired",
          candidate: candidate.id,
          plainHadReasoning: Boolean(plain.nonStreamShape?.hasReasoning || plain.streamShape?.hasReasoning),
        },
      };
    }
  }

  return {
    ok: false,
    error: plain.nonStreamShape?.hasContent && !plain.streamShape?.hasContent
      ? "MODEL_STREAMING_NO_CONTENT"
      : plain.nonStreamShape?.hasReasoning || plain.streamShape?.hasReasoning
        ? "MODEL_REASONING_ONLY"
        : "MODEL_NO_CONTENT",
  };
}

module.exports = {
  probeCustomModelProfile,
};
