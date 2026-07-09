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
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return {
    hasContent: content.trim().length > 0,
    hasReasoning: reasoning.trim().length > 0,
    hasToolCalls: toolCalls.length > 0,
  };
}

function streamShape(text) {
  let hasContent = false;
  let hasReasoning = false;
  let hasToolCalls = false;
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
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) hasToolCalls = true;
    } catch {
      // Ignore malformed chunks; the caller handles no-content as failure.
    }
  }
  return { hasContent, hasReasoning, hasToolCalls };
}

// Decoys mirroring Lily's real agent toolset: MCP tool names run long
// (lily_file_intelligence_extract_file_range = 41 chars) and several schemas
// nest an object property. Some gateways (e.g. OICM+) accept one short flat
// tool but return an HTML error page for any request containing these shapes,
// which breaks every real turn even though a simple tool probe passes. The
// decoys ride along the forced lily_probe_tool call and are never invoked.
const AGENT_SHAPE_DECOY_TOOLS = Object.freeze([
  {
    type: "function",
    function: {
      // 44 chars — covers Lily's longest real tool name with headroom
      name: "lily_probe_agent_tool_shape_name_len_check_a",
      description: "Probe decoy mirroring Lily's longest real tool names.",
      parameters: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lily_probe_nested_params",
      description: "Probe decoy mirroring Lily tools with nested object parameters.",
      parameters: {
        type: "object",
        properties: {
          range: {
            type: "object",
            properties: {
              start: { type: "integer" },
              end: { type: "integer" },
            },
            required: ["start"],
          },
        },
        required: ["range"],
        additionalProperties: false,
      },
    },
  },
]);

function toolProbeFields(extraTools = []) {
  return {
    tools: [{
      type: "function",
      function: {
        name: "lily_probe_tool",
        description: "Return a probe result.",
        parameters: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    }, ...extraTools],
    tool_choice: {
      type: "function",
      function: { name: "lily_probe_tool" },
    },
  };
}

async function postChat({ baseUrl, apiKey, model, bodyOverlay = null, stream = false, tools = false, extraTools = [], systemText = "", timeoutMs = 10_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("MODEL_PROBE_TIMEOUT")), Math.max(500, timeoutMs));
  const messages = [];
  if (systemText) messages.push({ role: "system", content: String(systemText) });
  messages.push({ role: "user", content: tools ? "Call lily_probe_tool with ok=true." : "Say pong only." });
  const body = mergeBody({
    model,
    messages,
    max_tokens: 16,
    stream: Boolean(stream),
    ...(tools ? toolProbeFields(extraTools) : {}),
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

async function probeTools({ baseUrl, apiKey, model, bodyOverlay = null, timeoutMs, extraTools = [] }) {
  const nonStream = await postChat({ baseUrl, apiKey, model, bodyOverlay, tools: true, extraTools, timeoutMs });
  if (!nonStream.ok) return { ok: false, error: nonStream.error || `HTTP_${nonStream.status || 0}` };
  const stream = await postChat({ baseUrl, apiKey, model, bodyOverlay, tools: true, extraTools, stream: true, timeoutMs });
  if (!stream.ok) return { ok: false, error: stream.error || `HTTP_${stream.status || 0}` };
  return {
    ok: true,
    nonStreamShape: nonStream.shape,
    streamShape: stream.shape,
    hasToolCalls: Boolean(nonStream.shape?.hasToolCalls && stream.shape?.hasToolCalls),
  };
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

async function validateAgentConformance({ baseUrl, apiKey, model, bodyOverlay = null, timeoutMs }) {
  const content = await probeCandidate({ baseUrl, apiKey, model, bodyOverlay, timeoutMs });
  if (!content.ok || !content.hasContent) return { ...content, hasAgentConformance: false };
  // Probe with decoys shaped like Lily's real toolset. A gateway can pass a
  // single short flat tool yet kill every real turn, so this is the probe
  // that actually predicts agent conformance.
  const tools = await probeTools({ baseUrl, apiKey, model, bodyOverlay, timeoutMs, extraTools: AGENT_SHAPE_DECOY_TOOLS });
  if (tools.ok && tools.hasToolCalls) {
    return { ...content, tools, hasAgentConformance: true };
  }
  // Distinguish "tool calls broken entirely" from "gateway rejects Lily-shaped
  // tools" so the save dialog can say which side to fix.
  const simpleTools = await probeTools({ baseUrl, apiKey, model, bodyOverlay, timeoutMs });
  return {
    ...content,
    tools: simpleTools.ok ? simpleTools : tools,
    hasAgentConformance: false,
    agentToolShapeRejected: Boolean(simpleTools.ok && simpleTools.hasToolCalls),
  };
}

const SYSTEM_PROMPT_PROBE_CANDIDATES = Object.freeze([32768, 24576, 16000, 12000, 10000, 8000, 6000, 4000]);

function promptProbeSlice(text, maxChars) {
  const source = String(text || "").trim();
  if (!source) return "";
  const notice = "\n\n[System guide truncated by Lily for this model's input limit.]";
  const limit = Math.max(1000, Math.floor(Number(maxChars) || 0));
  if (source.length <= limit) return source;
  return `${source.slice(0, Math.max(1000, limit - notice.length)).trimEnd()}${notice}`;
}

async function probeSystemPromptProfile({ baseUrl, apiKey, model, bodyOverlay = null, systemPromptProbeText = "", timeoutMs }) {
  const source = String(systemPromptProbeText || "").trim();
  if (!source) return null;
  for (const systemChars of SYSTEM_PROMPT_PROBE_CANDIDATES) {
    const systemText = promptProbeSlice(source, systemChars);
    const result = await postChat({ baseUrl, apiKey, model, bodyOverlay, systemText, timeoutMs });
    if (result.ok && result.shape?.hasContent) {
      return { systemMaxChars: Math.min(systemChars, source.length) };
    }
  }
  return null;
}

const BODY_OVERLAY_CANDIDATES = Object.freeze([
  {
    id: "disable-thinking",
    requestBodyOverlay: { chat_template_kwargs: { enable_thinking: false } },
  },
]);

// Bump when the probe learns to detect a new class of gateway defect. Stored
// profiles from older versions are treated as stale and re-probed by the
// settings-open / model-switch repair path, so existing presets pick up new
// compat findings without the user re-entering anything.
// v2: tool-shape decoys (long names + nested params) and toolShapeCompat.
const PROBE_PROFILE_VERSION = 2;

async function probeCustomModelProfile({
  protocol,
  baseUrl,
  apiKey,
  model,
  systemPromptProbeText = "",
  timeoutMs = 10_000,
} = {}) {
  if (protocol && protocol !== "openai") {
    return { ok: true, profile: {}, diagnostics: { skipped: "non-openai-protocol" } };
  }
  const plain = await validateAgentConformance({ baseUrl, apiKey, model, timeoutMs });
  if (!plain.ok) return { ok: false, error: plain.error };

  const finish = async ({ bodyOverlay = null, contentSource, toolShapeCompat = false, diagnostics = {} }) => {
    const prompt = await probeSystemPromptProfile({ baseUrl, apiKey, model, bodyOverlay, systemPromptProbeText, timeoutMs });
    return {
      ok: true,
      profile: {
        probeVersion: PROBE_PROFILE_VERSION,
        ...(bodyOverlay ? { requestBodyOverlay: bodyOverlay } : {}),
        ...(toolShapeCompat ? { toolShapeCompat: true } : {}),
        conformance: {
          chatCompletions: true,
          streaming: true,
          toolCalls: true,
          contentSource,
          ...(toolShapeCompat ? { toolShape: "compat" } : {}),
        },
        ...(prompt ? { prompt } : {}),
      },
      diagnostics,
    };
  };

  if (plain.hasAgentConformance) {
    return finish({ contentSource: "plain", diagnostics: { content: "plain", stream: "plain" } });
  }
  // Gateway rejects Lily-shaped tool definitions but a simple tool works:
  // runtime tool-shape compat (short MCP server keys + flat schemas) keeps
  // every real turn inside what this gateway accepts, so save the model with
  // the compat flag instead of rejecting it.
  if (plain.agentToolShapeRejected) {
    return finish({
      contentSource: "plain",
      toolShapeCompat: true,
      diagnostics: { content: "plain", stream: "plain", toolShape: "compat" },
    });
  }

  let toolCallsBlocked = Boolean(plain.hasContent && plain.tools && !plain.tools.hasToolCalls);
  for (const candidate of BODY_OVERLAY_CANDIDATES) {
    const repaired = await validateAgentConformance({
      baseUrl,
      apiKey,
      model,
      bodyOverlay: candidate.requestBodyOverlay,
      timeoutMs,
    });
    if (!repaired.ok) continue;
    const diagnostics = {
      content: "repaired",
      stream: "repaired",
      candidate: candidate.id,
      plainHadReasoning: Boolean(plain.nonStreamShape?.hasReasoning || plain.streamShape?.hasReasoning),
    };
    if (repaired.hasAgentConformance) {
      return finish({ bodyOverlay: candidate.requestBodyOverlay, contentSource: "body-overlay", diagnostics });
    }
    // A thinking-default model fails the plain content probe before the tools
    // stage ever runs, so the shape evidence often only appears here.
    if (repaired.agentToolShapeRejected) {
      return finish({
        bodyOverlay: candidate.requestBodyOverlay,
        contentSource: "body-overlay",
        toolShapeCompat: true,
        diagnostics: { ...diagnostics, toolShape: "compat" },
      });
    }
    if (repaired.hasContent && repaired.tools && !repaired.tools.hasToolCalls) toolCallsBlocked = true;
  }

  return {
    ok: false,
    error: toolCallsBlocked
      ? "MODEL_TOOL_CALLS_UNAVAILABLE"
      : plain.nonStreamShape?.hasContent && !plain.streamShape?.hasContent
      ? "MODEL_STREAMING_NO_CONTENT"
      : plain.nonStreamShape?.hasReasoning || plain.streamShape?.hasReasoning
        ? "MODEL_REASONING_ONLY"
        : "MODEL_NO_CONTENT",
  };
}

module.exports = {
  probeCustomModelProfile,
  PROBE_PROFILE_VERSION,
};
