"use strict";

const { taskRunSchemaVersion: TASK_RUN_SCHEMA_VERSION } = require("../../shared/runtime-contract.json");

const DEFAULT_STRING_LIMIT = 2_000;
const ASSISTANT_LIMIT = 16_000;
const TOOL_RESULT_LIMIT = 4_000;
const PROCESS_TEXT_LIMIT = 500;
const SUBAGENT_TEXT_LIMIT = 1_200;
const SUBAGENT_TOOL_RESULT_LIMIT = 800;

function truncateString(value, limit = DEFAULT_STRING_LIMIT) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit))}\n…[truncated ${text.length - limit} chars]`;
}

function safeJsonClone(value) {
  if (!value || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function compactValue(value, limit = DEFAULT_STRING_LIMIT, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value, limit);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactValue(item, limit, depth + 1));
  }
  if (typeof value !== "object") return null;
  if (depth >= 3) return "[object]";
  const out = {};
  for (const [key, val] of Object.entries(value).slice(0, 30)) {
    if (/thumbnail|dataUrl|dataURL|base64/i.test(key) && typeof val === "string") {
      out[key] = `[omitted ${val.length} chars]`;
      continue;
    }
    out[key] = compactValue(val, limit, depth + 1);
  }
  return out;
}

function compactMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return {};
  const keep = {};
  for (const key of [
    "sessionId",
    "sessionID",
    "messageId",
    "messageID",
    "model",
    "modelID",
    "providerID",
    "title",
    "status",
    "cwd",
    "exitCode",
  ]) {
    if (metadata[key] != null) keep[key] = compactValue(metadata[key], 500);
  }
  return keep;
}

function compactFile(file = {}) {
  if (!file || typeof file !== "object") return {};
  return {
    name: file.name || file.filename || "",
    path: file.path || "",
    sourcePath: file.sourcePath || "",
    type: file.type || file.mime || file.mediaType || "",
    kind: file.kind || "",
    extension: file.extension || "",
    size: Number.isFinite(file.size) ? file.size : null,
    pathOnly: Boolean(file.pathOnly),
    readable: file.readable !== false,
    isDirectory: Boolean(file.isDirectory),
    isImage: Boolean(file.isImage),
    thumbnail: typeof file.thumbnail === "string" && file.thumbnail
      ? `[omitted thumbnail ${file.thumbnail.length} chars]`
      : file.thumbnail || null,
  };
}

function compactTool(tool = {}, resultLimit = TOOL_RESULT_LIMIT) {
  const result = tool.result ?? tool.content ?? null;
  const resultText = typeof result === "string"
    ? result
    : result && typeof result === "object"
      ? JSON.stringify(compactValue(result, resultLimit))
      : "";
  return {
    id: tool.id || "",
    name: tool.name || tool.tool || "unknown",
    status: tool.status || "",
    title: tool.title || "",
    startedAt: tool.startedAt || 0,
    updatedAt: tool.updatedAt || tool.endedAt || 0,
    durationMs: Number.isFinite(tool.durationMs) ? tool.durationMs : null,
    input: compactValue(tool.input || {}, 800),
    metadata: compactMetadata(tool.metadata || {}),
    resultPreview: resultText ? truncateString(resultText, resultLimit) : "",
    resultBytes: resultText ? resultText.length : 0,
    resultTruncated: Boolean(resultText && resultText.length > resultLimit),
  };
}

function compactProcessEvent(payload = {}) {
  const effects = Array.isArray(payload.effects) ? payload.effects : [];
  return {
    rawType: String(payload.rawType || ""),
    rawSubtype: String(payload.rawSubtype || ""),
    summary: truncateString(payload.summary || "", PROCESS_TEXT_LIMIT),
    handled: Boolean(payload.handled),
    event: compactValue(payload.event || {}, PROCESS_TEXT_LIMIT),
    effects: effects.slice(0, 8).map((effect = {}) => ({
      kind: effect.kind || "",
      id: effect.id || "",
      name: effect.name || "",
      text: effect.text ? truncateString(effect.text, PROCESS_TEXT_LIMIT) : "",
      input: effect.input ? compactValue(effect.input, PROCESS_TEXT_LIMIT) : null,
      result: effect.result ? truncateString(effect.result, PROCESS_TEXT_LIMIT) : null,
      stopReason: effect.stopReason || "",
    })),
  };
}

function compactSubagent(subagent = {}) {
  const tools = Array.isArray(subagent.tools) ? subagent.tools : [];
  return {
    sessionId: subagent.sessionId || "",
    parentToolId: subagent.parentToolId || "",
    label: subagent.label || "general",
    description: truncateString(subagent.description || "", 500),
    status: subagent.status || "running",
    startedAt: subagent.startedAt || 0,
    updatedAt: subagent.updatedAt || 0,
    metadata: compactMetadata(subagent.metadata || {}),
    currentToolId: subagent.currentToolId || "",
    tools: tools.slice(-8).map((tool) => compactTool(tool, SUBAGENT_TOOL_RESULT_LIMIT)),
    textPreview: truncateString(subagent.textPreview || "", 600),
    thinkingPreview: truncateString(subagent.thinkingPreview || "", 300),
    textFull: truncateString(subagent.textFull || "", SUBAGENT_TEXT_LIMIT),
    pendingPermissions: compactValue(subagent.pendingPermissions || [], 500),
    pendingQuestions: compactValue(subagent.pendingQuestions || [], 500),
    phase: subagent.phase || "starting",
    phaseDetail: truncateString(subagent.phaseDetail || "", 500),
    stats: compactValue(subagent.stats || {}, 500),
    persistenceCompact: true,
  };
}

function compactSubagentPayload(payload = {}) {
  if (payload.subagent && typeof payload.subagent === "object") {
    return { subagent: compactSubagent(payload.subagent) };
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  return {
    sessionId: payload.sessionId || "",
    events: events.slice(-20).map((event = {}) => ({
      kind: event.kind || "",
      id: event.id || "",
      name: event.name || "",
      status: event.status || "",
      text: event.text ? truncateString(event.text, PROCESS_TEXT_LIMIT) : "",
      input: event.input ? compactValue(event.input, PROCESS_TEXT_LIMIT) : null,
      result: event.result ? truncateString(event.result, SUBAGENT_TOOL_RESULT_LIMIT) : null,
      metadata: compactMetadata(event.metadata || {}),
      ts: event.ts || 0,
    })),
    persistenceCompact: true,
  };
}

function compactTaskRun(taskRun = {}) {
  if (!taskRun || typeof taskRun !== "object") return null;
  return {
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    id: taskRun.id || "",
    sessionId: taskRun.sessionId || "",
    turnId: taskRun.turnId || "",
    objective: truncateString(taskRun.objective || "", 1_000),
    status: taskRun.status || "",
    completionStatus: taskRun.completionStatus || taskRun.status || "",
    intentContractId: truncateString(taskRun.intentContractId || "", 120),
    intentRevision: Number(taskRun.intentRevision || 0),
    intentRelation: truncateString(taskRun.intentRelation || "", 40),
    deliverables: compactValue(Array.isArray(taskRun.deliverables) ? taskRun.deliverables.slice(0, 12) : [], 500),
    successCriteria: compactValue(Array.isArray(taskRun.successCriteria) ? taskRun.successCriteria.slice(0, 20) : [], 500),
    phase: taskRun.phase || "",
    plan: Array.isArray(taskRun.plan)
      ? taskRun.plan.slice(0, 12).map((step = {}) => ({
          id: step.id || "",
          title: truncateString(step.title || "", 160),
          status: step.status || "",
        }))
      : [],
    activeStep: taskRun.activeStep || "",
    progress: compactValue(taskRun.progress || null, 500),
    liveness: compactValue(taskRun.liveness || null, 500),
    evidence: compactValue(Array.isArray(taskRun.evidence) ? taskRun.evidence.slice(-20) : [], 500),
    risks: compactValue(Array.isArray(taskRun.risks) ? taskRun.risks.slice(-20) : [], 500),
    resumeState: compactValue(taskRun.resumeState || {}, 500),
    verification: compactValue(taskRun.verification || null, 500),
    startedAt: taskRun.startedAt || null,
    updatedAt: taskRun.updatedAt || null,
    lastActivityAt: taskRun.lastActivityAt || null,
    endedAt: taskRun.endedAt || null,
  };
}

function compactTaskPayload(payload = {}) {
  return {
    taskRunId: payload.taskRunId || payload.taskRun?.id || "",
    status: payload.status || "",
    phase: payload.phase || "",
    activeStep: payload.activeStep || "",
    progress: compactValue(payload.progress || null, 500),
    liveness: compactValue(payload.liveness || null, 500),
    plan: compactValue(payload.plan || null, 500),
    evidence: compactValue(payload.evidence || null, 500),
    risk: compactValue(payload.risk || null, 500),
    tool: compactValue(payload.tool || null, 500),
    verification: compactValue(payload.verification || null, 500),
    evidenceSummary: compactValue(payload.evidenceSummary || null, 500),
    taskRun: compactTaskRun(payload.taskRun || null),
  };
}

function compactRecord(record = {}, assistant = "") {
  if (!record || typeof record !== "object") return null;
  return {
    turnId: record.turnId || "",
    sessionId: record.sessionId || "",
    startedAt: record.startedAt || null,
    endedAt: record.endedAt || null,
    terminal: record.terminal || "",
    assistantText: truncateString(record.assistantText || assistant || "", ASSISTANT_LIMIT),
    thinkingText: truncateString(record.thinkingText || "", DEFAULT_STRING_LIMIT),
    activityLabel: record.activityLabel || null,
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
    totalCostUsd: Number.isFinite(record.totalCostUsd) ? record.totalCostUsd : null,
    engineMessageId: record.engineMessageId || null,
    usage: compactValue(record.usage || null, 1_000),
    tools: Array.isArray(record.tools) ? record.tools.slice(-20).map((tool) => compactTool(tool, 1_000)) : [],
    fileChanges: compactValue(record.fileChanges || [], 1_000),
    artifacts: compactValue(record.artifacts || [], 1_000),
    resultBlocks: compactValue(record.resultBlocks || [], 1_000),
    meta: compactValue(record.meta || {}, 1_000),
    persistenceCompact: true,
  };
}

function compactTerminalPayload(payload = {}) {
  const assistant = truncateString(payload.assistant || "", ASSISTANT_LIMIT);
  const out = {
    ...compactValue(payload, 1_000),
    assistant,
  };
  if (payload.record && typeof payload.record === "object") {
    out.record = compactRecord(payload.record, assistant);
  }
  if (payload.scheduledDraft) {
    out.scheduledDraft = compactValue(payload.scheduledDraft, 2_000);
  }
  return out;
}

function compactRuntimeEventForPersistence(event = {}) {
  if (!event || typeof event !== "object") return event;
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  let compactPayload;
  switch (event.type) {
    case "process.event":
      compactPayload = compactProcessEvent(payload);
      break;
    case "subagent.event":
      compactPayload = compactSubagentPayload(payload);
      break;
    case "task.created":
    case "task.plan.updated":
    case "task.step.started":
    case "task.step.progress":
    case "task.step.completed":
    case "task.step.failed":
    case "task.evidence.added":
    case "task.risk.detected":
    case "task.liveness.updated":
    case "task.stalled":
    case "task.resumed":
    case "task.completed":
    case "task.failed":
    case "task.interrupted":
      compactPayload = compactTaskPayload(payload);
      break;
    case "tool.started":
    case "tool.input.done":
      compactPayload = {
        ...payload,
        input: compactValue(payload.input || {}, 1_000),
        metadata: compactMetadata(payload.metadata || {}),
      };
      break;
    case "tool.done":
      compactPayload = {
        id: payload.id || "",
        status: payload.status || "",
        isError: Boolean(payload.isError),
        result: payload.result != null ? truncateString(
          typeof payload.result === "string" ? payload.result : JSON.stringify(compactValue(payload.result, 1_000)),
          TOOL_RESULT_LIMIT,
        ) : null,
        content: payload.content != null ? truncateString(String(payload.content), TOOL_RESULT_LIMIT) : undefined,
        metadata: compactMetadata(payload.metadata || {}),
        title: payload.title || "",
      };
      break;
    case "user.committed":
      compactPayload = {
        text: truncateString(payload.text || "", ASSISTANT_LIMIT),
        files: Array.isArray(payload.files) ? payload.files.map(compactFile) : null,
        ...(payload.steer ? { steer: true, steerSeq: payload.steerSeq ?? null } : {}),
      };
      break;
    case "assistant.final":
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
    case "turn.stalled":
      compactPayload = compactTerminalPayload(payload);
      break;
    default:
      compactPayload = compactValue(payload, DEFAULT_STRING_LIMIT);
      break;
  }
  if (compactPayload && typeof compactPayload === "object" && !Array.isArray(compactPayload)) {
    compactPayload.persistenceCompact = true;
  }

  return {
    ...event,
    payload: safeJsonClone(compactPayload) || {},
  };
}

module.exports = {
  compactTaskRun,
  compactRuntimeEventForPersistence,
  truncateString,
};
