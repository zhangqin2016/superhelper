import store from "./state.js";
import { sanitizeNoticeForIngest } from "./engine-notice-policy.js";
import { alertTaskDone } from "./task-alert.js";
import {
  activityFromEngineNotice,
  applyProcessEventToTimeline,
  appendTimelineNotice,
  appendTimelineText,
  closeStreamingBlocks,
  hasRunningTool,
  resetTimelineFields,
  setActivityLabel,
  upsertTimelineThinking,
  upsertTimelineTool,
} from "./turn-timeline.js";

const sessions = new Map();
const sessionAccessOrder = new Set();
const batchSeqBySession = new Map();
const eventSeqBySession = new Map();
const terminalTurns = new Set();
const listeners = new Set();
let notifyQueued = false;
export const SESSION_RUNTIME_CACHE_LIMIT = 40;

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
    // Session-list "needs attention" flag set when a BACKGROUND turn finishes:
    // null | "done" (completed) | "failed". Cleared when the user views it.
    attention: null,
  };
}

export function getRuntimeSession(sessionId) {
  if (!sessionId) return emptySession("");
  if (!sessions.has(sessionId)) sessions.set(sessionId, emptySession(sessionId));
  touchRuntimeSession(sessionId);
  return sessions.get(sessionId);
}

function touchRuntimeSession(sessionId) {
  if (sessionAccessOrder.has(sessionId)) sessionAccessOrder.delete(sessionId);
  sessionAccessOrder.add(sessionId);
  evictRuntimeSessionCaches();
}

function shouldPreserveRuntimeSession(sessionId) {
  if (!sessionId) return true;
  if (sessionId === store.get("activeSessionId")) return true;
  const runtime = sessions.get(sessionId);
  if (!runtime) return false;
  return runtime.phase !== "idle" || Boolean(runtime.turnId) || Boolean(runtime.liveTurn);
}

function dropRuntimeSessionCache(sessionId) {
  sessions.delete(sessionId);
  batchSeqBySession.delete(sessionId);
  eventSeqBySession.delete(sessionId);
  sessionAccessOrder.delete(sessionId);
  for (const key of [...terminalTurns]) {
    if (key.startsWith(`${sessionId}:`)) terminalTurns.delete(key);
  }
}

export function evictRuntimeSessionCaches(limit = SESSION_RUNTIME_CACHE_LIMIT) {
  if (sessions.size <= limit) return [];
  const evicted = [];
  for (const sessionId of [...sessionAccessOrder]) {
    if (sessions.size <= limit) break;
    if (shouldPreserveRuntimeSession(sessionId)) continue;
    dropRuntimeSessionCache(sessionId);
    evicted.push(sessionId);
  }
  return evicted;
}

export function getCachedRuntimeSessionIds() {
  return [...sessions.keys()];
}

function committedMessageKey(message) {
  if (message?.turnId && message?.role) return `turn:${message.role}:${message.turnId}`;
  if (message?.id) return `id:${message.id}`;
  return ["fallback", message?.role || "", message?.timestamp || "", message?.content || ""].join(":");
}

function belongsToActiveTurn(runtime, message) {
  const turnId = message?.turnId || "";
  const activeTurnId = runtime.turnId || runtime.liveTurn?.turnId || "";
  return Boolean(turnId && activeTurnId && turnId === activeTurnId);
}

export function syncCommittedMessages(sessionId, messages) {
  if (!sessionId) return;
  const runtime = getRuntimeSession(sessionId);
  const incoming = Array.isArray(messages) ? messages : [];

  const shouldPreserveLocal =
    runtime.phase !== "idle" ||
    Boolean(runtime.turnId) ||
    Boolean(runtime.queue?.length);
  if (!shouldPreserveLocal) {
    runtime.committedMessages = incoming;
    return;
  }

  // Busy sessions may have live user/task messages that the backend has not
  // flushed yet. Only preserve messages that can be proven to belong to the
  // active turn. Unrelated local-only user messages are queued work and must
  // not be appended to history, or session switches can visually attach the
  // wrong question to the running turn.
  const seen = new Set(incoming.map((message) => committedMessageKey(message)));
  const localOnly = [];
  for (const message of runtime.committedMessages) {
    const key = committedMessageKey(message);
    if (seen.has(key)) continue;
    if (!belongsToActiveTurn(runtime, message)) continue;
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
  if (!runtime._turnStartedAt) runtime._turnStartedAt = Date.now(); // for the completion-alert duration gate
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
    applyRuntimeEvent(event, opts);
  }
  if (opts.notifyAfter !== false) notify();
}

export function applyRuntimeEvent(event, opts = {}) {
  const lastSeq = eventSeqBySession.get(event.sessionId) || 0;
  if (Number.isInteger(event.seq) && event.seq <= lastSeq) return;
  if (Number.isInteger(event.seq)) eventSeqBySession.set(event.sessionId, event.seq);

  const runtime = getRuntimeSession(event.sessionId);
  if (event.type === "user.committed") {
    const turnKey = event.turnId ? `${event.sessionId}:${event.turnId}` : "";
    if (turnKey && terminalTurns.has(turnKey)) return;
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
    runtime.attention = null; // new activity supersedes any stale "finished" flag
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
  if (terminalTurns.has(turnKey) && TERMINAL_TYPES.has(event.type)) return;
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
      appendTimelineText(live, event.payload.text || "", event.ts || Date.now());
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
    case "permission.timeout": {
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
    case "assistant.message_stop":
      closeStreamingBlocks(live, event.ts || Date.now());
      break;
    default:
      if (TERMINAL_TYPES.has(event.type)) {
        live.phase = "done";
        live.final = event;
        closeStreamingBlocks(live, event.ts || Date.now());
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
          closeStreamingBlocks(live, event.ts || Date.now());
        }
        if (event.payload?.record?.activityLabel) {
          live.activityLabel = event.payload.record.activityLabel;
        }
        if (Array.isArray(event.payload?.record?.fileChanges)) {
          live.fileChanges = event.payload.record.fileChanges;
        }
        // Carry the record's derived artifacts/result blocks onto the live turn
        // so a just-completed turn shows its previews immediately — matching the
        // reload-from-record render instead of only appearing after a restart.
        if (Array.isArray(event.payload?.record?.artifacts)) {
          live.artifacts = event.payload.record.artifacts;
        }
        if (Array.isArray(event.payload?.record?.resultBlocks)) {
          live.resultBlocks = event.payload.record.resultBlocks;
        }
        if (event.payload?.record?.usage) {
          live.usage = event.payload.record.usage;
        }
        runtime.phase = "idle";
        runtime.turnId = null;
        terminalTurns.add(turnKey);
        // Flag the session list when a BACKGROUND session finishes (not the one
        // being viewed) on a LIVE event — so the user knows to come look. Skips
        // load-time replay (allowReplay) and the active session. An interrupt is
        // user-initiated, so it raises no flag.
        if (!opts.allowReplay && event.sessionId !== store.get("activeSessionId")) {
          if (event.type === "turn.completed") runtime.attention = "done";
          else if (event.type === "turn.failed" || event.type === "turn.stalled") runtime.attention = "failed";
        }
        // Attention-aware completion alert (sound + OS notification). Fires on live
        // terminal events only; alertTaskDone() itself decides whether to actually
        // notify based on window focus / active session / duration.
        if (!opts.allowReplay) {
          const durationMs = runtime._turnStartedAt ? Date.now() - runtime._turnStartedAt : 0;
          alertTaskDone({
            sessionId: event.sessionId,
            ok: event.type === "turn.completed",
            durationMs,
            activeSessionId: store.get("activeSessionId"),
            snippet: String(event.payload?.assistant || live.assistantText || ""),
          });
        }
        runtime._turnStartedAt = 0;
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

// Optimistic local state: the user pressed stop and must see "stopping" —
// the terminal event from the main process later resolves the real outcome.
export function markSessionStopping(sessionId) {
  const runtime = getRuntimeSession(sessionId);
  if (!runtime.turnId && !runtime.liveTurn) return;
  runtime.phase = "stopping";
  if (runtime.liveTurn && !runtime.liveTurn.final) {
    runtime.liveTurn.phase = "stopping";
  }
  notify();
}

export function getTurnId(sessionId) {
  return getRuntimeSession(sessionId).turnId;
}

export function isActiveSessionBusy() {
  return !canSend(store.get("activeSessionId"));
}

// Session-list "needs attention" flag: "done" | "failed" | null.
export function getSessionAttention(sessionId) {
  return getRuntimeSession(sessionId).attention || null;
}

// Clear the flag once the user views the session (call on switch/focus).
export function clearSessionAttention(sessionId) {
  const runtime = getRuntimeSession(sessionId);
  if (runtime.attention) {
    runtime.attention = null;
    notify();
  }
}
