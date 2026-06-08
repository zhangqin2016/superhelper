import store from "./state.js";
import { sanitizeNoticeForIngest } from "./engine-notice-policy.js";
import {
  activityFromEngineNotice,
  applyProcessEventToTimeline,
  appendTimelineNotice,
  hasRunningTool,
  resetTimelineFields,
  setActivityLabel,
  upsertTimelineThinking,
  upsertTimelineTool,
} from "./turn-timeline.js";

const sessions = new Map();
const batchSeqBySession = new Map();
const eventSeqBySession = new Map();
const terminalTurns = new Set();
const listeners = new Set();
let notifyQueued = false;

const TERMINAL_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.stalled",
]);

function emptySession(sessionId) {
  return {
    sessionId,
    phase: "idle",
    turnId: null,
    liveTurn: null,
    queue: [],
    promptSuggestions: [],
    committedMessages: [],
  };
}

export function getRuntimeSession(sessionId) {
  if (!sessionId) return emptySession("");
  if (!sessions.has(sessionId)) sessions.set(sessionId, emptySession(sessionId));
  return sessions.get(sessionId);
}

function committedMessageKey(message) {
  if (message?.turnId && message?.role) return `turn:${message.role}:${message.turnId}`;
  if (message?.id) return `id:${message.id}`;
  return ["fallback", message?.role || "", message?.timestamp || "", message?.content || ""].join(":");
}

export function syncCommittedMessages(sessionId, messages) {
  if (!sessionId) return;
  const runtime = getRuntimeSession(sessionId);
  const incoming = Array.isArray(messages) ? messages : [];
  const hasActiveLiveTurn = runtime.liveTurn && runtime.liveTurn.phase !== "done";
  const hasLiveState = runtime.phase !== "idle" || hasActiveLiveTurn || runtime.queue.length > 0;
  if (!hasLiveState) {
    runtime.committedMessages = incoming;
    return;
  }

  const seen = new Set(incoming.map((message) => committedMessageKey(message)));
  const localOnly = [];
  for (const message of runtime.committedMessages) {
    const key = committedMessageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    localOnly.push(message);
  }
  runtime.committedMessages = [...incoming, ...localOnly];
}

export function hydrateRuntimeFromState(state) {
  for (const project of state?.projects || []) {
    for (const session of project.sessions || []) {
      getRuntimeSession(session.id);
    }
  }
  for (const [sessionId, snap] of Object.entries(state?.runtime?.sessions || {})) {
    const runtime = getRuntimeSession(sessionId);
    runtime.phase = snap.phase || "idle";
    runtime.turnId = snap.turnId || null;
    runtime.queue = snap.queue || [];
    if (snap.runtime?.recent?.length) {
      applyRuntimeBatch({
        sessionId,
        batchSeq: snap.runtime.batchSeq || 0,
        events: snap.runtime.recent,
      }, { notifyAfter: false, allowReplay: true });
    }
  }
  notify();
}

export function subscribeRuntime(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function scheduleNotifyFlush(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 0);
}

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  scheduleNotifyFlush(() => {
    notifyQueued = false;
    for (const fn of listeners) fn();
  });
}

function ensureLiveTurn(runtime, event) {
  if (!runtime.liveTurn || runtime.liveTurn.turnId !== event.turnId) {
    runtime.liveTurn = {
      turnId: event.turnId,
      phase: "starting",
      assistantText: "",
      thinkingText: "",
      contentBlocks: [],
      protocolUnknown: [],
      processEvents: [],
      timeline: [],
      activityLabel: null,
      durationMs: null,
      totalCostUsd: null,
      tools: new Map(),
      notices: [],
      permissions: new Map(),
      questions: new Map(),
      hooks: new Map(),
      startedAt: event.ts || Date.now(),
      updatedAt: event.ts || Date.now(),
      final: null,
      fileChanges: [],
      usage: null,
    };
  }
  runtime.turnId = event.turnId;
  return runtime.liveTurn;
}

function noticeKey(event) {
  const notice = event?.payload?.notice || event?.payload || {};
  return notice.replacesCode || notice.code || event.type;
}

function addNotice(live, event) {
  const notice = sanitizeNoticeForIngest(event?.payload?.notice || event?.payload || {});
  if (!notice || notice.panel === false) return;
  const normalized = {
    ...event,
    payload: {
      ...(event?.payload || {}),
      notice,
    },
  };
  if (notice.replace || notice.replacesCode) {
    const key = noticeKey(normalized);
    const index = live.notices.findIndex((existing) => noticeKey(existing) === key);
    if (index >= 0) {
      live.notices[index] = normalized;
      return;
    }
  }
  live.notices.push(normalized);
  if (live.notices.length > 20) live.notices.splice(0, live.notices.length - 20);
}

export function applyRuntimeBatch(batch, opts = {}) {
  if (!batch?.sessionId || !Array.isArray(batch.events)) return;
  const lastBatch = batchSeqBySession.get(batch.sessionId) || 0;
  if (!opts.allowReplay && batch.batchSeq && batch.batchSeq <= lastBatch) return;
  if (batch.batchSeq) batchSeqBySession.set(batch.sessionId, batch.batchSeq);

  for (const event of batch.events) {
    applyRuntimeEvent(event);
  }
  if (opts.notifyAfter !== false) notify();
}

export function applyRuntimeEvent(event) {
  const lastSeq = eventSeqBySession.get(event.sessionId) || 0;
  if (Number.isInteger(event.seq) && event.seq <= lastSeq) return;
  if (Number.isInteger(event.seq)) eventSeqBySession.set(event.sessionId, event.seq);

  const runtime = getRuntimeSession(event.sessionId);
  if (event.type === "user.committed") {
    runtime.committedMessages.push({
      role: "user",
      content: event.payload.text || "",
      files: event.payload.files || undefined,
      turnId: event.turnId || undefined,
      timestamp: new Date(event.ts).toISOString(),
    });
    return;
  }
  if (event.type === "queue.updated") {
    runtime.queue = event.payload.items || [];
    return;
  }
  if (event.type === "prompt_suggestions.updated") {
    runtime.promptSuggestions = event.payload.suggestions || [];
    return;
  }
  if (event.type === "turn.started") {
    runtime.phase = "starting";
    const live = ensureLiveTurn(runtime, event);
    live.phase = "starting";
    return;
  }
  if (!event.turnId && event.type.startsWith("engine.")) {
    if (runtime.liveTurn) addNotice(runtime.liveTurn, event);
    return;
  }
  if (!event.turnId) return;
  const turnKey = `${event.sessionId}:${event.turnId}`;
  if (terminalTurns.has(turnKey) && !TERMINAL_TYPES.has(event.type)) return;

  const live = ensureLiveTurn(runtime, event);
  live.updatedAt = event.ts || Date.now();

  switch (event.type) {
    case "turn.accepted":
      runtime.phase = "streaming";
      live.phase = "streaming";
      break;
    case "assistant.delta":
      runtime.phase = "streaming";
      live.phase = "streaming";
      live.assistantText += event.payload.text || "";
      break;
    case "assistant.thinking.delta":
      runtime.phase = "streaming";
      live.phase = "streaming";
      live.thinkingText += event.payload.text || "";
      upsertTimelineThinking(live, event.payload.text || "", event.ts || Date.now());
      break;
    case "content.block":
      live.contentBlocks.push({
        blockType: event.payload.blockType || "unknown",
        mediaType: event.payload.mediaType || "",
        data: event.payload.data || "",
        ts: event.ts || Date.now(),
      });
      if (live.contentBlocks.length > 20) {
        live.contentBlocks.splice(0, live.contentBlocks.length - 20);
      }
      break;
    case "protocol.unknown":
      live.protocolUnknown.push({
        kind: event.payload.kind || "unknown_runtime_event",
        notice: event.payload.notice || null,
        event: event.payload.event || null,
        ts: event.ts || Date.now(),
      });
      if (live.protocolUnknown.length > 20) {
        live.protocolUnknown.splice(0, live.protocolUnknown.length - 20);
      }
      break;
    case "process.event":
      live.processEvents.push(event);
      applyProcessEventToTimeline(live, event.payload || {}, event.ts || Date.now());
      if (live.processEvents.length > 200) {
        live.processEvents.splice(0, live.processEvents.length - 200);
      }
      break;
    case "tool.started":
      runtime.phase = "tool_running";
      live.phase = "tool_running";
      live.tools.set(event.payload.id, { ...event.payload, status: "running" });
      upsertTimelineTool(live, { ...event.payload, status: "running" }, event.ts || Date.now());
      break;
    case "tool.input.delta": {
      const tool = live.tools.get(event.payload.id) || { id: event.payload.id };
      tool.partialJson = (tool.partialJson || "") + (event.payload.partialJson || "");
      live.tools.set(event.payload.id, tool);
      upsertTimelineTool(live, tool, event.ts || Date.now());
      break;
    }
    case "tool.input.done": {
      const tool = live.tools.get(event.payload.id) || { id: event.payload.id };
      tool.input = event.payload.input || {};
      live.tools.set(event.payload.id, tool);
      upsertTimelineTool(live, tool, event.ts || Date.now());
      break;
    }
    case "tool.done": {
      const tool = live.tools.get(event.payload.id) || { id: event.payload.id };
      tool.status = event.payload.status || "done";
      tool.result = event.payload.result || null;
      live.tools.set(event.payload.id, tool);
      upsertTimelineTool(live, tool, event.ts || Date.now());
      break;
    }
    case "permission.requested":
      runtime.phase = "awaiting_user";
      live.phase = "awaiting_user";
      live.permissions.set(event.payload.requestId, event.payload);
      break;
    case "permission.resolved":
      live.permissions.delete(event.payload.requestId);
      break;
    case "user_question.requested":
      runtime.phase = "awaiting_user";
      live.phase = "awaiting_user";
      live.questions.set(event.payload.requestId, event.payload);
      break;
    case "user_question.resolved":
      live.questions.delete(event.payload.requestId);
      break;
    case "hook.requested":
      runtime.phase = "awaiting_user";
      live.phase = "awaiting_user";
      live.hooks.set(event.payload.requestId, event.payload);
      break;
    case "hook.resolved":
      live.hooks.delete(event.payload.requestId);
      break;
    case "engine.notice":
    case "engine.warning":
    case "engine.stderr":
    case "permission.timeout":
    case "recovery.scheduled":
    case "recovery.started": {
      const notice = sanitizeNoticeForIngest(event?.payload?.notice || event?.payload || {});
      const activity = activityFromEngineNotice(notice);
      if (activity && !hasRunningTool(live.tools)) setActivityLabel(live, activity);
      if (notice) appendTimelineNotice(live, notice, event.ts || Date.now());
      addNotice(live, event);
      break;
    }
    case "usage.updated":
      live.usage = event.payload || {};
      break;
    case "assistant.final":
      live.finalDraft = event.payload.assistant || live.assistantText;
      break;
    default:
      if (TERMINAL_TYPES.has(event.type)) {
        live.phase = "done";
        live.final = event;
        if (Number.isFinite(event.payload?.durationMs)) {
          live.durationMs = event.payload.durationMs;
        } else if (Number.isFinite(event.payload?.record?.durationMs)) {
          live.durationMs = event.payload.record.durationMs;
        }
        if (Number.isFinite(event.payload?.totalCostUsd)) {
          live.totalCostUsd = event.payload.totalCostUsd;
        } else if (Number.isFinite(event.payload?.record?.totalCostUsd)) {
          live.totalCostUsd = event.payload.record.totalCostUsd;
        }
        if (Array.isArray(event.payload?.record?.timeline) && event.payload.record.timeline.length) {
          live.timeline = event.payload.record.timeline;
        }
        if (event.payload?.record?.activityLabel) {
          live.activityLabel = event.payload.record.activityLabel;
        }
        if (Array.isArray(event.payload?.record?.fileChanges)) {
          live.fileChanges = event.payload.record.fileChanges;
        }
        if (event.payload?.record?.usage) {
          live.usage = event.payload.record.usage;
        }
        runtime.phase = "idle";
        runtime.turnId = null;
        terminalTurns.add(turnKey);
        runtime.committedMessages.push({
          role: "assistant",
          content: event.payload.assistant || live.assistantText || "",
          record: event.payload.record || null,
          failed: event.type === "turn.failed",
          turnId: event.turnId,
          timestamp: new Date(event.ts).toISOString(),
          meta: event.payload.record?.meta || {
            terminal: event.type,
            tools: event.payload.toolsSummary,
          },
        });
      }
  }
}

export function canSend(sessionId) {
  return getRuntimeSession(sessionId).phase === "idle";
}

export function canInterrupt(sessionId) {
  const phase = getRuntimeSession(sessionId).phase;
  return phase !== "idle" && phase !== "finalizing";
}

export function isSessionRunning(sessionId) {
  return getRuntimeSession(sessionId).phase !== "idle";
}

export function anySessionRunning() {
  for (const runtime of sessions.values()) {
    if (runtime.phase !== "idle") return true;
  }
  return false;
}

export function getTurnPhase(sessionId) {
  return getRuntimeSession(sessionId).phase;
}

export function getTurnId(sessionId) {
  return getRuntimeSession(sessionId).turnId;
}

export function isActiveSessionBusy() {
  return !canSend(store.get("activeSessionId"));
}
