import store from "./state.js";
import { sanitizeNoticeForIngest } from "./engine-notice-policy.js";
import { alertTaskDone } from "./task-alert.js";
import { removeSupersededAssistant } from "./assistant-supersession.js";
import {
  activityFromEngineNotice,
  setActivityLabel,
} from "./turn-activity-policy.js";
import { appendTimelineNotice } from "./turn-notice-timeline.js";
import { applyTurnPaused, applyTurnSteered } from "./turn-lifecycle-projection.js";
import { applyProcessEventToTimeline } from "./turn-process-activity-timeline.js";
import { resetTimelineFields } from "./turn-reset-timeline.js";
import {
  appendTimelineText,
  closeStreamingBlocks,
  upsertTimelineThinking,
} from "./turn-streaming-blocks.js";
import {
  hasRunningTool,
  upsertTimelineTool,
} from "./turn-tool-timeline.js";
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
    switchNotices: [], // character switch notices (Phase 2B §8), deduped by bindingVersion
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

export const getCachedRuntimeSessionIds = () => [...sessions.keys()];
export function peekSessionRuntimeStatus(sessionId) {
  const runtime = sessionId ? sessions.get(sessionId) : null; return { running: Boolean(runtime && runtime.phase !== "idle"), attention: runtime?.attention || null };
}
function committedMessageKey(message) {
  if (message?.turnId && message?.role) {
    // A steered ("插话") message is a SECOND user message inside the same turn — it
    // must not collide with (and overwrite) the turn's original user bubble, so key
    // it by its per-turn steer sequence. The marker rides top-level (live) or meta
    // (reloaded from the store).
    const isSteer = message.steer || message.meta?.steer;
    if (isSteer) {
      const seq = message.steerSeq ?? message.meta?.steerSeq ?? normalizedMessageText(message);
      return `turn:${message.role}:${message.turnId}:steer:${seq}`;
    }
    return `turn:${message.role}:${message.turnId}`;
  }
  if (message?.id) return `id:${message.id}`;
  return ["fallback", message?.role || "", message?.timestamp || "", message?.content || ""].join(":");
}

function normalizedMessageText(message = {}) {
  return String(message.content || message.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function scheduledDraftFingerprint(message = {}) {
  const signature = scheduledDraftSignature(message);
  if (!signature) return "";
  return [
    "scheduledDraft",
    signature.originalText,
    signature.title,
    signature.scheduleText,
    signature.rrule,
  ].join(":");
}

function scheduledDraftSignature(message = {}) {
  const scheduledDraft = message.meta?.scheduledDraft || message.record?.meta?.scheduledDraft || null;
  if (!scheduledDraft) return null;
  const draft = scheduledDraft.draft && typeof scheduledDraft.draft === "object"
    ? scheduledDraft.draft
    : scheduledDraft;
  return {
    originalText: normalizedMessageText({ content: scheduledDraft.originalText || draft.originalText || "" }),
    title: normalizedMessageText({ content: scheduledDraft.prompt || scheduledDraft.title || draft.prompt || draft.title || "" }),
    scheduleText: normalizedMessageText({ content: scheduledDraft.scheduleText || scheduledDraft.summary || draft.scheduleText || draft.summary || "" }),
    rrule: normalizedMessageText({ content: scheduledDraft.rrule || draft.rrule || "" }),
  };
}

function scheduledDraftsMatch(a = {}, b = {}) {
  const left = scheduledDraftSignature(a);
  const right = scheduledDraftSignature(b);
  if (!left || !right) return false;
  if (left.originalText && right.originalText && left.originalText !== right.originalText) return false;
  if (!left.title || !right.title || left.title !== right.title) return false;
  if (left.scheduleText && right.scheduleText && left.scheduleText !== right.scheduleText) return false;
  if (left.rrule && right.rrule && left.rrule !== right.rrule) return false;
  return Boolean(left.originalText || right.originalText || left.scheduleText || right.scheduleText || left.rrule || right.rrule);
}

function sameContentWithinWindow(a = {}, b = {}, windowMs = 30 * 60 * 1000) {
  if (a.role !== b.role) return false;
  const aText = normalizedMessageText(a);
  const bText = normalizedMessageText(b);
  if (!aText || !bText || aText !== bText) return false;
  const at = timestampMs(a.timestamp);
  const bt = timestampMs(b.timestamp);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return false;
  return Math.abs(at - bt) <= windowMs;
}

function isProjectionLikeMessage(message = {}) {
  const id = String(message.id || "");
  return Boolean(
    id.startsWith("projection:") ||
      message.meta?.projected ||
      message.record?.meta?.projected ||
      message.meta?.displaySource === "lily-raw-user"
  );
}

function isLikelyProjectionDuplicate(a = {}, b = {}) {
  if (a.role !== "user" || b.role !== "user") return false;
  if (a.steer || a.meta?.steer || b.steer || b.meta?.steer) return false;
  if (!sameContentWithinWindow(a, b)) return false;
  return Boolean(
    isProjectionLikeMessage(a) ||
      isProjectionLikeMessage(b) ||
      Boolean(a.turnId) !== Boolean(b.turnId)
  );
}

// A rich assistant turn keeps its answer in `record.assistantText` with an empty
// top-level `content`; the official OpenCode refresh of the same turn carries the
// plain text in `content`. With different keys (the official copy did not inherit
// the Lily turnId) and no shared text, the two would survive as separate bubbles
// and the finished turn duplicates on reopen. Match them on comparable text
// (content/text/record.assistantText) within a window so they collapse into one.
function assistantComparableText(message = {}) {
  return normalizedMessageText({
    content: message.content || message.text || message.record?.assistantText || "",
  });
}

// A rich committed turn (loaded local-first) and the official refresh copy of the
// SAME turn rarely have byte-identical text: the rich record prepends a ✓ step
// summary / appends report sections, so one is a SUPERSET of the other. Requiring
// exact equality let both survive as separate bubbles → the finished turn shows
// twice on reopen. Treat them as the same turn when the texts are equal OR — for
// substantial text — one contains the other. The length guard keeps short,
// genuinely-different replies from over-merging.
function assistantTextEquivalent(a, b) {
  // The official engine copy and the Lily copy of the SAME turn are only NEARLY
  // identical: whitespace differs (CJK "问题。 定位" vs "问题。定位") and lengths
  // differ (one is richer/longer), and they share no key (the official copy has
  // no turnId, different message ids). So compare with ALL whitespace removed
  // (insignificant for CJK) and accept equal, one-contains-the-other, OR a long
  // shared prefix (tolerates mid/tail divergence). The length guard keeps short,
  // genuinely-different replies from over-merging.
  const sa = String(a || "").replace(/\s+/g, "");
  const sb = String(b || "").replace(/\s+/g, "");
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const shorter = sa.length <= sb.length ? sa : sb;
  const longer = sa.length <= sb.length ? sb : sa;
  if (shorter.length < 80) return false;
  if (longer.includes(shorter)) return true;
  let k = 0;
  while (k < shorter.length && shorter.charCodeAt(k) === longer.charCodeAt(k)) k += 1;
  return k >= 80;
}

function sameAssistantTurnWithinWindow(a = {}, b = {}, windowMs = 30 * 60 * 1000) {
  if (a.role !== "assistant" || b.role !== "assistant") return false;
  const aText = assistantComparableText(a);
  const bText = assistantComparableText(b);
  if (!assistantTextEquivalent(aText, bText)) return false;
  const at = timestampMs(a.timestamp);
  const bt = timestampMs(b.timestamp);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return false;
  return Math.abs(at - bt) <= windowMs;
}

function messageQuality(message = {}) {
  let score = 0;
  if (message.id) score += 1;
  if (message.turnId) score += 2;
  if (message.record) score += 4;
  if (message.meta) score += 2;
  if (message.files?.length) score += 1;
  return score;
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function recordRichness(record = null) {
  if (!record || typeof record !== "object") return 0;
  let score = 1;
  score += countArray(record.resultBlocks) * 5;
  score += countArray(record.artifacts) * 4;
  score += countArray(record.contentBlocks) * 4;
  score += countArray(record.timeline) * 2;
  score += countArray(record.processEvents) * 2;
  score += countArray(record.notices);
  score += countArray(record.tools);
  if (record.assistantText) score += 1;
  if (record.engineMessageId) score += 1;
  if (record.persistenceCompact) score -= 4;
  return score;
}

function mergeCommittedRecord(existingRecord = null, incomingRecord = null) {
  if (!existingRecord) return incomingRecord || null;
  if (!incomingRecord) return existingRecord;
  return recordRichness(incomingRecord) >= recordRichness(existingRecord)
    ? incomingRecord
    : existingRecord;
}

function equivalentCommittedMessageIndex(messages, message) {
  const key = committedMessageKey(message);
  const draftKey = scheduledDraftFingerprint(message);
  for (let i = 0; i < messages.length; i += 1) {
    const existing = messages[i];
    if (committedMessageKey(existing) === key) return i;
    if (scheduledDraftsMatch(existing, message)) return i;
    if (draftKey && scheduledDraftFingerprint(existing) === draftKey) return i;
    if (isLikelyProjectionDuplicate(existing, message)) return i;
    if (sameAssistantTurnWithinWindow(existing, message)) return i;
  }
  return -1;
}

function mergeCommittedMessage(existing = {}, incoming = {}) {
  const preferIncoming = messageQuality(incoming) >= messageQuality(existing);
  const base = preferIncoming ? { ...existing, ...incoming } : { ...incoming, ...existing };
  const record = mergeCommittedRecord(existing.record, incoming.record);
  return {
    ...base,
    id: incoming.id || existing.id,
    content: incoming.content || existing.content || "",
    files: incoming.files || existing.files,
    turnId: incoming.turnId || existing.turnId,
    record,
    failed: Boolean(incoming.failed || existing.failed),
    meta: {
      ...(existing.meta || {}),
      ...(incoming.meta || {}),
    },
  };
}

function dedupeCommittedMessages(messages = []) {
  const out = [];
  for (const message of messages || []) {
    if (!message?.role) continue;
    const index = equivalentCommittedMessageIndex(out, message);
    if (index < 0) {
      out.push(message);
      continue;
    }
    out[index] = mergeCommittedMessage(out[index], message);
  }
  return out;
}

function mergeIncomingCommittedMessages(existingMessages = [], incomingMessages = []) {
  return (incomingMessages || []).map((message) => {
    if (!message?.role) return message;
    const index = equivalentCommittedMessageIndex(existingMessages, message);
    return index >= 0 ? mergeCommittedMessage(existingMessages[index], message) : message;
  });
}

function upsertCommittedMessage(runtime, message) {
  const index = equivalentCommittedMessageIndex(runtime.committedMessages, message);
  if (index < 0) {
    runtime.committedMessages.push(message);
    return;
  }
  runtime.committedMessages[index] = mergeCommittedMessage(runtime.committedMessages[index], message);
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
  const mergedIncoming = mergeIncomingCommittedMessages(runtime.committedMessages, incoming);

  const shouldPreserveLocal =
    runtime.phase !== "idle" ||
    Boolean(runtime.turnId) ||
    Boolean(runtime.queue?.length);
  if (!shouldPreserveLocal) {
    runtime.committedMessages = dedupeCommittedMessages(mergedIncoming);
    return;
  }

  // Busy sessions may have live user/task messages that the backend has not
  // flushed yet. Only preserve messages that can be proven to belong to the
  // active turn. Unrelated local-only user messages are queued work and must
  // not be appended to history, or session switches can visually attach the
  // wrong question to the running turn.
  const seen = new Set(mergedIncoming.map((message) => committedMessageKey(message)));
  const localOnly = [];
  for (const message of runtime.committedMessages) {
    const key = committedMessageKey(message);
    if (seen.has(key)) continue;
    if (!belongsToActiveTurn(runtime, message)) continue;
    seen.add(key);
    localOnly.push(message);
  }
  runtime.committedMessages = dedupeCommittedMessages([...mergedIncoming, ...localOnly]);
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

export function notify() {
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
      subagents: new Map(),
      notices: [],
      permissions: new Map(),
      questions: new Map(),
      hooks: new Map(),
      startedAt: event.ts || Date.now(),
      updatedAt: event.ts || Date.now(),
      final: null,
      fileChanges: [],
      usage: null,
      taskRun: null,
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

function hasPendingPrompts(live = {}) {
  return Boolean(
    live.permissions?.size ||
    live.questions?.size ||
    live.hooks?.size,
  );
}

function compactTaskRunForStore(taskRun = null) {
  if (!taskRun || typeof taskRun !== "object") return null;
  return {
    schemaVersion: Number(taskRun.schemaVersion || 1),
    id: taskRun.id || "",
    sessionId: taskRun.sessionId || "",
    turnId: taskRun.turnId || "",
    objective: taskRun.objective || "",
    status: taskRun.status || "",
    completionStatus: taskRun.completionStatus || taskRun.status || "",
    intentContractId: taskRun.intentContractId || "",
    intentRevision: Number(taskRun.intentRevision || 0),
    intentRelation: taskRun.intentRelation || "new",
    deliverables: Array.isArray(taskRun.deliverables) ? taskRun.deliverables : [],
    successCriteria: Array.isArray(taskRun.successCriteria) ? taskRun.successCriteria : [],
    phase: taskRun.phase || "",
    plan: Array.isArray(taskRun.plan) ? taskRun.plan : [],
    activeStep: taskRun.activeStep || "",
    progress: taskRun.progress || null,
    liveness: taskRun.liveness || null,
    evidence: Array.isArray(taskRun.evidence) ? taskRun.evidence : [],
    risks: Array.isArray(taskRun.risks) ? taskRun.risks : [],
    resumeState: taskRun.resumeState || {},
    verification: taskRun.verification || null,
    startedAt: taskRun.startedAt || null,
    updatedAt: taskRun.updatedAt || null,
    lastActivityAt: taskRun.lastActivityAt || null,
    endedAt: taskRun.endedAt || null,
  };
}

export { compactTaskRunForStore };

function applyTaskRunEvent(live, event = {}) {
  const payload = event.payload || {};
  const full = compactTaskRunForStore(payload.taskRun || null);
  const current = live.taskRun || {};
  live.taskRun = full || {
    ...current,
    id: payload.taskRunId || current.id || "",
    turnId: event.turnId || current.turnId || "",
    status: payload.status || current.status || "",
    completionStatus: payload.completionStatus || current.completionStatus || payload.status || current.status || "",
    phase: payload.phase || current.phase || "",
    activeStep: payload.activeStep || current.activeStep || "",
    progress: payload.progress || current.progress || null,
    liveness: payload.liveness || current.liveness || null,
    plan: payload.plan || current.plan || [],
    verification: payload.verification || current.verification || null,
    updatedAt: event.ts || Date.now(),
  };
  if (payload.evidence) {
    const evidence = Array.isArray(live.taskRun.evidence) ? live.taskRun.evidence : [];
    live.taskRun.evidence = [...evidence, payload.evidence].slice(-20);
  }
  if (payload.risk) {
    const risks = Array.isArray(live.taskRun.risks) ? live.taskRun.risks : [];
    live.taskRun.risks = [...risks, payload.risk].slice(-20);
  }
  if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.interrupted" || event.type === "task.stalled") {
    live.taskRun.status = payload.status || live.taskRun.status || event.type.slice("task.".length);
    live.taskRun.completionStatus = payload.completionStatus || live.taskRun.completionStatus || live.taskRun.status;
    live.taskRun.endedAt = live.taskRun.endedAt || event.ts || Date.now();
  }
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
  if (event.type === "assistant.supersedes") return void removeSupersededAssistant(runtime, String(event.payload?.supersedes || ""));
  if (event.type === "user.committed") {
    const turnKey = event.turnId ? `${event.sessionId}:${event.turnId}` : "";
    if (turnKey && terminalTurns.has(turnKey)) return;
    const isSteer = Boolean(event.payload.steer);
    upsertCommittedMessage(runtime, {
      role: "user",
      content: event.payload.text || "",
      files: event.payload.files || undefined,
      turnId: event.turnId || undefined,
      timestamp: new Date(event.ts).toISOString(),
      ...(isSteer ? { steer: true, steerSeq: event.payload.steerSeq } : {}),
      meta: isSteer ? { steer: true, steerSeq: event.payload.steerSeq } : undefined,
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
    case "task.created":
    case "task.plan.updated":
    case "task.step.started":
    case "task.step.progress":
    case "task.step.completed":
    case "task.step.failed":
    case "task.evidence.added":
    case "task.risk.detected":
    case "task.liveness.updated":
    case "task.resumed":
    case "task.completed":
    case "task.failed":
    case "task.interrupted":
    case "task.stalled":
      applyTaskRunEvent(live, event);
      break;
    case "subagent.event": {
      const item = event.payload?.subagent || null;
      if (item?.sessionId) {
        const existing = live.subagents.get(item.sessionId) || {};
        live.subagents.set(item.sessionId, {
          ...existing,
          ...item,
          tools: Array.isArray(item.tools) ? item.tools : (existing.tools || []),
        });
      }
      break;
    }
    case "todo.updated": {
      const tool = {
        id: event.payload.id || `todo_${event.sessionId || "current"}`,
        name: "todowrite",
        input: { todos: Array.isArray(event.payload.todos) ? event.payload.todos : [] },
        status: "done",
        result: null,
        parentToolUseId: null,
      };
      live.tools.set(tool.id, tool);
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
      if (live.phase === "awaiting_user" && !hasPendingPrompts(live)) {
        runtime.phase = "streaming";
        live.phase = "streaming";
      }
      break;
    case "user_question.requested":
      runtime.phase = "awaiting_user";
      live.phase = "awaiting_user";
      live.questions.set(event.payload.requestId, event.payload);
      break;
    case "user_question.resolved":
      live.questions.delete(event.payload.requestId);
      if (live.phase === "awaiting_user" && !hasPendingPrompts(live)) {
        runtime.phase = "streaming";
        live.phase = "streaming";
      }
      break;
    case "hook.requested":
      runtime.phase = "awaiting_user";
      live.phase = "awaiting_user";
      live.hooks.set(event.payload.requestId, event.payload);
      break;
    case "hook.resolved":
      live.hooks.delete(event.payload.requestId);
      if (live.phase === "awaiting_user" && !hasPendingPrompts(live)) {
        runtime.phase = "streaming";
        live.phase = "streaming";
      }
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
    case "turn.steered":
      applyTurnSteered(live, event);
      break;
    case "turn.paused":
      applyTurnPaused(runtime, live, event);
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
        if (event.payload?.record?.meta?.taskRun) {
          live.taskRun = compactTaskRunForStore(event.payload.record.meta.taskRun);
        }
        if (event.payload?.record?.meta?.memoryUsage) {
          live.memoryUsage = event.payload.record.meta.memoryUsage;
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
        upsertCommittedMessage(runtime, {
          role: "assistant",
          id: event.payload.messageId || undefined,
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
  const runtime = getRuntimeSession(sessionId);
  if (runtime.phase === "idle") return true;
  if (!runtime.turnId || runtime.liveTurn?.final) {
    runtime.phase = "idle";
    runtime.turnId = null;
    return true;
  }
  return false;
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
