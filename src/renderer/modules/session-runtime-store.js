import store from "./state.js";

const sessions = new Map();
const batchSeqBySession = new Map();
const eventSeqBySession = new Map();
const terminalTurns = new Set();
const listeners = new Set();

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
    committedMessages: [],
  };
}

export function getRuntimeSession(sessionId) {
  if (!sessionId) return emptySession("");
  if (!sessions.has(sessionId)) sessions.set(sessionId, emptySession(sessionId));
  return sessions.get(sessionId);
}

export function hydrateRuntimeFromState(state) {
  for (const project of state?.projects || []) {
    for (const session of project.sessions || []) {
      const runtime = getRuntimeSession(session.id);
      runtime.committedMessages = session.messages || [];
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

function notify() {
  for (const fn of listeners) fn();
}

function ensureLiveTurn(runtime, event) {
  if (!runtime.liveTurn || runtime.liveTurn.turnId !== event.turnId) {
    runtime.liveTurn = {
      turnId: event.turnId,
      phase: "starting",
      assistantText: "",
      thinkingText: "",
      processEvents: [],
      tools: new Map(),
      notices: [],
      permissions: new Map(),
      questions: new Map(),
      hooks: new Map(),
      startedAt: event.ts || Date.now(),
      updatedAt: event.ts || Date.now(),
      final: null,
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
  const notice = event?.payload?.notice || event?.payload || {};
  if (notice.panel === false) return;
  if (notice.replace || notice.replacesCode) {
    const key = noticeKey(event);
    const index = live.notices.findIndex((existing) => noticeKey(existing) === key);
    if (index >= 0) {
      live.notices[index] = event;
      return;
    }
  }
  live.notices.push(event);
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
  if (event.type === "turn.started") {
    runtime.phase = "starting";
    const live = ensureLiveTurn(runtime, event);
    live.phase = "starting";
    return;
  }
  if (!event.turnId && event.type.startsWith("engine.")) {
    runtime.liveTurn?.notices.push(event);
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
      break;
    case "process.event":
      live.processEvents.push(event);
      if (live.processEvents.length > 200) {
        live.processEvents.splice(0, live.processEvents.length - 200);
      }
      break;
    case "tool.started":
      runtime.phase = "tool_running";
      live.phase = "tool_running";
      live.tools.set(event.payload.id, { ...event.payload, status: "running" });
      break;
    case "tool.input.delta": {
      const tool = live.tools.get(event.payload.id) || { id: event.payload.id };
      tool.partialJson = (tool.partialJson || "") + (event.payload.partialJson || "");
      live.tools.set(event.payload.id, tool);
      break;
    }
    case "tool.input.done": {
      const tool = live.tools.get(event.payload.id) || { id: event.payload.id };
      tool.input = event.payload.input || {};
      live.tools.set(event.payload.id, tool);
      break;
    }
    case "tool.done": {
      const tool = live.tools.get(event.payload.id) || { id: event.payload.id };
      tool.status = event.payload.status || "done";
      tool.result = event.payload.result || null;
      live.tools.set(event.payload.id, tool);
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
    case "recovery.started":
      addNotice(live, event);
      break;
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
        runtime.phase = "idle";
        runtime.turnId = null;
        terminalTurns.add(turnKey);
        runtime.committedMessages.push({
          role: "assistant",
          content: event.payload.assistant || live.assistantText || "",
          failed: event.type === "turn.failed",
          turnId: event.turnId,
          timestamp: new Date(event.ts).toISOString(),
          meta: {
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
