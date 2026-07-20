"use strict";

const { getLogger } = require("./logger");
const {
  isSubagentTool,
  SLOW_SUBAGENT_MS,
  VERY_SLOW_SUBAGENT_MS,
  subagentTitle,
} = require("./subagent-telemetry");

const log = getLogger("subagent-runtime-projection");

function createSubagentItem(sessionId, now = Date.now()) {
  return {
    sessionId,
    parentToolId: "",
    label: "general",
    description: "",
    status: "running",
    startedAt: now,
    updatedAt: now,
    tools: new Map(),
    textPreview: "",
    thinkingPreview: "",
    textFull: "",
    thinkingFull: "",
    metadata: {},
    pendingPermissions: [],
    pendingQuestions: [],
    phase: "starting",
    phaseDetail: "",
    stats: {},
  };
}

function subagentToolPhase(name) {
  const tool = String(name || "").toLowerCase();
  if (["read", "grep", "glob", "list", "ls"].includes(tool)) return "searching";
  if (tool === "bash") return "running_command";
  if (["edit", "write", "patch", "multiedit"].includes(tool)) return "editing";
  if (tool.includes("web")) return "researching";
  return "using_tool";
}

function subagentPhaseDetail(tool = null) {
  if (!tool) return "";
  const input = tool.input || {};
  return String(
    input.file_path ||
    input.path ||
    input.pattern ||
    input.query ||
    input.command ||
    input.description ||
    input.prompt ||
    tool.title ||
    tool.name ||
    "",
  ).trim().slice(0, 180);
}

function refreshSubagentPhase(item = {}) {
  const tools = [...(item.tools?.values?.() || [])];
  const runningTools = tools.filter((tool) => {
    const status = String(tool.status || "");
    return status === "running" || status === "pending";
  });
  const failedTools = tools.filter((tool) => String(tool.status || "") === "failed");
  const doneTools = tools.filter((tool) => ["done", "completed"].includes(String(tool.status || "")));
  const nestedTasks = tools.filter((tool) => String(tool.name || "").toLowerCase() === "task");
  const pending = (item.pendingPermissions?.length || 0) + (item.pendingQuestions?.length || 0);
  const current =
    runningTools.find((tool) => tool.id === item.currentToolId) ||
    runningTools.at(-1) ||
    tools.find((tool) => tool.id === item.currentToolId) ||
    tools.at(-1) ||
    null;

  item.stats = {
    totalTools: tools.length,
    runningTools: runningTools.length,
    doneTools: doneTools.length,
    failedTools: failedTools.length,
    nestedTasks: nestedTasks.length,
    pendingPrompts: pending,
  };
  item.phaseDetail = subagentPhaseDetail(current);
  if (item.status === "failed" || failedTools.length) item.phase = "failed";
  else if (item.status === "done" || item.status === "completed") item.phase = "done";
  else if (pending > 0) item.phase = "awaiting_user";
  else if (
    current &&
    String(current.name || "").toLowerCase() === "task" &&
    ["running", "pending"].includes(String(current.status || ""))
  ) item.phase = "delegating";
  else if (current && ["running", "pending"].includes(String(current.status || ""))) {
    item.phase = subagentToolPhase(current.name);
  } else if (String(item.textPreview || "").trim()) item.phase = "summarizing";
  else if (String(item.thinkingPreview || "").trim()) item.phase = "planning";
  else item.phase = "starting";
  return item;
}

function compactSubagent(item = {}) {
  refreshSubagentPhase(item);
  return {
    sessionId: item.sessionId || "",
    parentToolId: item.parentToolId || "",
    label: item.label || "general",
    description: item.description || "",
    status: item.status || "running",
    startedAt: item.startedAt || 0,
    updatedAt: item.updatedAt || 0,
    metadata: item.metadata || {},
    currentToolId: item.currentToolId || "",
    tools: [...(item.tools?.values?.() || [])].slice(-20),
    textPreview: item.textPreview || "",
    thinkingPreview: item.thinkingPreview || "",
    textFull: item.textFull || "",
    pendingPermissions: item.pendingPermissions || [],
    pendingQuestions: item.pendingQuestions || [],
    phase: item.phase || "starting",
    phaseDetail: item.phaseDetail || "",
    stats: item.stats || {},
    ...(item.lastError ? { lastError: item.lastError } : {}),
  };
}

function createSubagentRuntimeProjection(options = {}) {
  const getState = options.getState;
  const emitEngineNotice = options.emitEngineNotice || (() => {});
  const onEngineError = options.onEngineError || (() => {});
  const now = options.now || (() => Date.now());
  const scheduleTimer = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;

  function failOpen(operation, err) {
    log.warn("subagent %s failed open: %s", operation, err?.message || err);
  }

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  function clearWatch(sessionId, toolId) {
    try {
      const state = stateFor(sessionId);
      const timers = state.subagentTimers?.get(toolId) || [];
      for (const timer of timers) cancelTimer(timer);
      state.subagentTimers?.delete(toolId);
    } catch (err) {
      failOpen("watch cleanup", err);
    }
  }

  function scheduleWatch(sessionId, toolId, tool = {}) {
    try {
      if (!isSubagentTool(tool)) return;
      const state = stateFor(sessionId);
      if (!state.subagentTimers) state.subagentTimers = new Map();
      clearWatch(sessionId, toolId);
      const timers = [];
      const title = subagentTitle(tool);
      for (const [ms, code] of [
        [SLOW_SUBAGENT_MS, "subagentSlow"],
        [VERY_SLOW_SUBAGENT_MS, "subagentVerySlow"],
      ]) {
        const timer = scheduleTimer(() => {
          try {
            const current = stateFor(sessionId).tools.get(toolId);
            if (!current || current.status !== "running") return;
            emitEngineNotice(sessionId, {
              code,
              level: "progress",
              panel: true,
              replace: true,
              replacesCode: `subagent:${toolId}`,
              detail: `子任务仍在运行：${title}（已 ${Math.round(ms / 1000)} 秒）。正在等待 Lily 子任务回传结果。`,
            });
          } catch (err) {
            failOpen("watch notification", err);
          }
        }, ms);
        timer?.unref?.();
        timers.push(timer);
      }
      state.subagentTimers.set(toolId, timers);
    } catch (err) {
      failOpen("watch scheduling", err);
    }
  }

  function clearAllWatches(sessionId) {
    try {
      const state = stateFor(sessionId);
      for (const toolId of [...(state.subagentTimers?.keys?.() || [])]) clearWatch(sessionId, toolId);
    } catch (err) {
      failOpen("watch cleanup", err);
    }
  }

  function emitDoneNotice(sessionId, tool = {}) {
    try {
      if (!isSubagentTool(tool)) return;
      const durationMs = Number(tool.durationMs || 0);
      if (durationMs < SLOW_SUBAGENT_MS) return;
      const seconds = Math.max(1, Math.round(durationMs / 1000));
      emitEngineNotice(sessionId, {
        code: "subagentCompleted",
        level: "progress",
        panel: true,
        replace: true,
        replacesCode: `subagent:${tool.id}`,
        done: true,
        detail: `子任务完成：${subagentTitle(tool)}（${seconds} 秒）。`,
      });
    } catch (err) {
      failOpen("completion notification", err);
    }
  }

  function syncFromTool(sessionId, tool = {}) {
    try {
      if (!isSubagentTool(tool)) return null;
      const meta = tool.metadata || {};
      const childSessionId = meta.sessionId || meta.sessionID || "";
      if (!childSessionId) return null;
      const state = stateFor(sessionId);
      if (!state.subagents) state.subagents = new Map();
      const current = state.subagents.get(childSessionId) || createSubagentItem(childSessionId, now());
      current.parentToolId = tool.id || current.parentToolId || "";
      current.label = String(tool.input?.subagent_type || tool.input?.subagentType || current.label || "general");
      current.description = subagentTitle(tool) || current.description || "";
      current.status = tool.status === "failed"
        ? "failed"
        : (tool.status === "done" || tool.status === "completed") ? "done" : "running";
      current.metadata = { ...(current.metadata || {}), ...meta };
      current.updatedAt = now();
      refreshSubagentPhase(current);
      state.subagents.set(childSessionId, current);
      return compactSubagent(current);
    } catch (err) {
      failOpen("tool synchronization", err);
      return null;
    }
  }

  function applyEvent(sessionId, payload = {}) {
    try {
      const childSessionId = String(payload.sessionId || "").trim();
      if (!childSessionId) return null;
      const state = stateFor(sessionId);
      if (!state.subagents) state.subagents = new Map();
      const item = state.subagents.get(childSessionId) || createSubagentItem(childSessionId, now());
      const events = Array.isArray(payload.events) ? payload.events : [];

      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        if (event.kind === "tool") {
          const id = event.id || `tool_${item.tools.size + 1}`;
          const existing = item.tools.get(id) || { id, startedAt: event.ts || now() };
          const next = {
            ...existing,
            id,
            name: event.name || existing.name || "unknown",
            status: event.status || existing.status || "running",
            input: event.input || existing.input || {},
            result: event.result ?? existing.result ?? null,
            metadata: event.metadata || existing.metadata || {},
            title: event.title || existing.title || "",
            updatedAt: event.ts || now(),
          };
          item.tools.set(id, next);
          item.currentToolId = id;
          item.status = next.status === "failed" ? "failed" : item.status === "done" ? "done" : "running";
        } else if (event.kind === "text") {
          item.textPreview = `${item.textPreview || ""}${event.text || ""}`.slice(-600);
          item.textFull = `${item.textFull || ""}${event.text || ""}`.slice(-8_000);
        } else if (event.kind === "thinking") {
          item.thinkingPreview = `${item.thinkingPreview || ""}${event.text || ""}`.slice(-300);
          item.thinkingFull = `${item.thinkingFull || ""}${event.text || ""}`.slice(-4_000);
        } else if (event.kind === "usage") {
          item.usage = event.usage || {};
        } else if (event.kind === "permission") {
          const requestId = event.requestId || event.rawRequestId || "";
          item.pendingPermissions = Array.isArray(item.pendingPermissions) ? item.pendingPermissions : [];
          if (event.status === "requested" && requestId && !item.pendingPermissions.some((entry) => entry.requestId === requestId)) {
            item.pendingPermissions.push({
              requestId,
              rawRequestId: event.rawRequestId || "",
              toolName: event.toolName || "",
              status: event.status,
              ts: event.ts || now(),
            });
          } else if (requestId && event.status !== "requested") {
            item.pendingPermissions = item.pendingPermissions.filter((entry) => (
              entry.requestId !== requestId && entry.rawRequestId !== requestId
            ));
          }
        } else if (event.kind === "question") {
          const requestId = event.requestId || event.rawRequestId || "";
          item.pendingQuestions = Array.isArray(item.pendingQuestions) ? item.pendingQuestions : [];
          if (event.status === "requested" && requestId && !item.pendingQuestions.some((entry) => entry.requestId === requestId)) {
            item.pendingQuestions.push({
              requestId,
              rawRequestId: event.rawRequestId || "",
              status: event.status,
              ts: event.ts || now(),
            });
          } else if (requestId && event.status !== "requested") {
            item.pendingQuestions = item.pendingQuestions.filter((entry) => (
              entry.requestId !== requestId && entry.rawRequestId !== requestId
            ));
          }
        } else if (event.kind === "error") {
          item.status = "failed";
          item.lastError = {
            message: String(event.message || "").slice(0, 500),
            ts: event.ts || now(),
          };
          try {
            onEngineError(sessionId, childSessionId, item.lastError.message);
          } catch (err) {
            failOpen("engine error observer", err);
          }
        }
        item.updatedAt = event.ts || now();
      }

      refreshSubagentPhase(item);
      state.subagents.set(childSessionId, item);
      return { subagent: compactSubagent(item) };
    } catch (err) {
      failOpen("event projection", err);
      return null;
    }
  }

  return {
    applyEvent,
    clearAllWatches,
    clearWatch,
    emitDoneNotice,
    scheduleWatch,
    syncFromTool,
  };
}

module.exports = {
  compactSubagent,
  createSubagentRuntimeProjection,
  refreshSubagentPhase,
  subagentPhaseDetail,
  subagentToolPhase,
};
