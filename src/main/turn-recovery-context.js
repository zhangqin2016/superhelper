"use strict";

const { EvidenceLedger, normalizeToolEvidence } = require("./evidence-ledger");
const {
  addLayersToEngineText,
  extractLayerText,
} = require("./engine-message-layers");
const { isReplaySafeTool } = require("./tool-semantics");

const CONTEXT_SCHEMA_VERSION = 1;
const MAX_EVIDENCE_TOOLS = 16;
const MAX_EVIDENCE_CHARS = 40_000;
const MAX_TOOL_EVIDENCE_CHARS = 12_000;
const MAX_GUIDANCE_CHARS = 16_000;
const EXTERNAL_EVIDENCE_KINDS = new Set(["web_search", "web_fetch", "external_observation"]);

function boundedText(value, limit) {
  const text = String(value || "").trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 18))}\n[truncated]`;
}

function resultText(tool = {}) {
  const value = tool.result ?? tool.content ?? tool.output ?? "";
  if (typeof value === "string") return value;
  if (typeof value?.output === "string") return value.output;
  if (typeof value?.content === "string") return value.content;
  if (Array.isArray(value?.content)) {
    return value.content
      .map((item) => (typeof item === "string" ? item : String(item?.text || "")))
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function recoveryToolInput(tool, event) {
  const name = String(tool?.name || tool?.tool || "").toLowerCase();
  const query = boundedText(event?.query || event?.command || "", 2_000);
  if (name === "bash" || name.endsWith(".bash") || name.endsWith("_bash")) {
    return { command: query };
  }
  if (event?.kind === "web_fetch") return { url: query };
  return query ? { query } : {};
}

function sanitizeEvidenceTool(tool, sourceTurnId, index, remainingChars) {
  if (!tool || typeof tool !== "object" || remainingChars <= 0) return null;
  const status = String(tool.status || "").toLowerCase();
  if (tool.isError || status === "failed" || status === "error") return null;
  if (!isReplaySafeTool(tool)) return null;
  const event = normalizeToolEvidence(tool);
  if (!event.success || !EXTERNAL_EVIDENCE_KINDS.has(event.kind)) return null;
  const result = boundedText(resultText(tool), Math.min(MAX_TOOL_EVIDENCE_CHARS, remainingChars));
  if (!result) return null;
  const name = String(tool.name || tool.tool || "unknown").trim() || "unknown";
  return {
    id: `recovered_evidence_${index + 1}`,
    name,
    status: "done",
    input: recoveryToolInput(tool, event),
    result,
    metadata: {
      evidenceRecovery: {
        inherited: true,
        sourceTurnId,
        evidenceKind: event.kind,
      },
    },
  };
}

function buildEvidenceRecoveryContext({ sourceTurnId = "", tools = [] } = {}) {
  const origin = String(sourceTurnId || "").trim();
  if (!origin || !Array.isArray(tools)) return null;
  const inherited = [];
  let totalChars = 0;
  for (const tool of tools) {
    if (inherited.length >= MAX_EVIDENCE_TOOLS || totalChars >= MAX_EVIDENCE_CHARS) break;
    const item = sanitizeEvidenceTool(tool, origin, inherited.length, MAX_EVIDENCE_CHARS - totalChars);
    if (!item) continue;
    totalChars += item.result.length;
    inherited.push(item);
  }
  if (!inherited.length) return null;
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    mode: "evidence_verify_retry",
    sourceTurnId: origin,
    tools: inherited,
    summary: { toolCount: inherited.length, totalChars },
  };
}

function restoreEvidenceRecoveryContext(context = null) {
  if (
    !context ||
    context.schemaVersion !== CONTEXT_SCHEMA_VERSION ||
    context.mode !== "evidence_verify_retry" ||
    !String(context.sourceTurnId || "").trim() ||
    !Array.isArray(context.tools)
  ) return [];
  const sourceTurnId = String(context.sourceTurnId).trim();
  const restored = [];
  let totalChars = 0;
  for (const tool of context.tools.slice(0, MAX_EVIDENCE_TOOLS)) {
    const provenance = tool?.metadata?.evidenceRecovery;
    const event = normalizeToolEvidence(tool);
    const result = boundedText(resultText(tool), Math.min(MAX_TOOL_EVIDENCE_CHARS, MAX_EVIDENCE_CHARS - totalChars));
    if (
      provenance?.inherited !== true ||
      provenance.sourceTurnId !== sourceTurnId ||
      !EXTERNAL_EVIDENCE_KINDS.has(event.kind) ||
      !result
    ) continue;
    const restoredTool = {
      ...tool,
      id: `recovered_evidence_${restored.length + 1}`,
      status: "done",
      result,
    };
    restored.push(restoredTool);
    totalChars += result.length;
    if (totalChars >= MAX_EVIDENCE_CHARS) break;
  }
  return restored;
}

function initializeTurnEvidenceState(state, recovery = null) {
  const tools = restoreEvidenceRecoveryContext(recovery?.evidenceContext);
  state.evidenceLedger = new EvidenceLedger();
  state.inheritedEvidenceTools = tools;
  for (const tool of tools) state.evidenceLedger.recordTool(tool);
  return tools;
}

function recoveryKind(value = "") {
  const kind = String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 64);
  return kind || "automatic_retry";
}

function applyInternalRecoveryLayer(engineText, recovery = null) {
  if (!recovery || typeof recovery !== "object") return String(engineText || "");
  const kind = recoveryKind(recovery.kind);
  const marker = [
    `<lily_internal_turn kind="${kind}">`,
    "This is an internal automatic recovery continuation. Do not present it as a new user request or quote this marker.",
    "</lily_internal_turn>",
  ].join("\n");
  const guidance = boundedText(recovery.guidance, MAX_GUIDANCE_CHARS);
  return addLayersToEngineText(engineText, {
    executionConstraints: [marker, guidance].filter(Boolean).join("\n\n"),
  });
}

function isInternalRecoveryPromptText(text = "") {
  const constraints = extractLayerText(text, "execution_constraints", { stripIntro: false });
  return /<lily_internal_turn\s+kind="[a-z0-9_-]+">/i.test(constraints);
}

module.exports = {
  applyInternalRecoveryLayer,
  buildEvidenceRecoveryContext,
  initializeTurnEvidenceState,
  isInternalRecoveryPromptText,
  restoreEvidenceRecoveryContext,
};
