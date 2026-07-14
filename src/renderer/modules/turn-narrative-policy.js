import { getRenderableTimeline } from "./turn-renderable-timeline.js";
import { classifyToolCategory } from "./turn-tool-model.js";

const CLI_ASSISTANT_TERMINALS = new Set([
  "turn.stalled",
  "turn.interrupted",
  "turn.failed",
]);

const EVIDENCE_GATE_NOTICE_RE = /^证据门槛：/;

export function normalizeForDedup(text = "") {
  return String(text).trim().replace(/\s+/g, " ");
}

export function collectFileToolBodies(liveTurn = {}) {
  const bodies = [];
  for (const entry of getRenderableTimeline(liveTurn)) {
    if (entry.kind !== "tool") continue;
    const cat = classifyToolCategory(entry.name);
    if (cat !== "write") continue;
    const input = entry.input || {};
    for (const key of ["content", "new_string"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) {
        bodies.push(normalizeForDedup(value));
      }
    }
  }
  return bodies;
}

export function textMatchesFileToolBody(text, liveTurn = {}) {
  const normalized = normalizeForDedup(text);
  if (!normalized) return false;
  const bodies = collectFileToolBodies(liveTurn);
  return bodies.some((body) => body === normalized || body.includes(normalized) || normalized.includes(body));
}

/** Assistant text the CLI actually streamed or committed; no synthesis from tools. */
export function lastTimelineText(liveTurn = {}) {
  const timeline = Array.isArray(liveTurn.timeline) ? liveTurn.timeline : [];
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "text") return String(timeline[index].text || "").trim();
  }
  return null;
}

export function resolveAssistantStreamText(liveTurn = {}) {
  const blockText = lastTimelineText(liveTurn);
  if (liveTurn.final?.payload?.assistant != null) {
    const finalText = String(liveTurn.final.payload.assistant).trim();
    if (blockText && finalText.endsWith(blockText)) return blockText;
    if (blockText) {
      const blockIndex = finalText.lastIndexOf(blockText);
      if (blockIndex >= 0) {
        const suffix = finalText.slice(blockIndex + blockText.length).trim();
        if (EVIDENCE_GATE_NOTICE_RE.test(suffix)) {
          return `${blockText}\n\n${suffix}`;
        }
      }
    }
    return finalText;
  }
  if (blockText != null) return blockText;
  return String(liveTurn.assistantText || "").trim();
}

export function hasCliResult(liveTurn = {}) {
  return liveTurn.final?.payload?.resultFromCli === true;
}

export function shouldShowNarrative(liveTurn = {}) {
  const text = resolveAssistantStreamText(liveTurn);
  if (!text) return false;
  if (Boolean(liveTurn.final)) {
    if (liveTurn.final.type === "turn.completed") {
      if (hasCliResult(liveTurn)) return false;
      return !textMatchesFileToolBody(text, liveTurn);
    }
    if (CLI_ASSISTANT_TERMINALS.has(liveTurn.final.type)) {
      return !textMatchesFileToolBody(text, liveTurn);
    }
    return false;
  }
  if (textMatchesFileToolBody(text, liveTurn)) return false;
  return true;
}

export function resolveFinalText(liveTurn = {}) {
  return resolveAssistantStreamText(liveTurn);
}

export function shouldShowFinal(liveTurn = {}) {
  if (liveTurn.final?.type !== "turn.completed") return false;
  if (!hasCliResult(liveTurn)) return false;
  const finalText = resolveFinalText(liveTurn);
  if (!finalText) return false;
  if (textMatchesFileToolBody(finalText, liveTurn)) return false;

  const tools = getRenderableTimeline(liveTurn).filter((entry) => entry.kind === "tool" || entry.kind === "toolGroup");
  const writeTools = tools.filter((tool) => classifyToolCategory(tool.name) === "write");
  if (writeTools.length > 0 && tools.length === writeTools.length) {
    const shortAck = finalText.length <= 240 && !finalText.includes("\n\n");
    if (shortAck) return false;
  }
  return true;
}
