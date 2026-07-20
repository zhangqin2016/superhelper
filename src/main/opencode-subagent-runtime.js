"use strict";

const { getLogger } = require("./logger");
const { decidePermission } = require("./runtime/opencode-permission-policy");
const {
  createOpencodeRuntimeState,
  reduceOpencodeRuntimeEvent,
} = require("./runtime/opencode-runtime-reducer");

const log = getLogger("opencode-subagent-runtime");

function childRequestId(sessionID, rawRequestId) {
  const safeSession = String(sessionID || "").replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const safeRequest = String(rawRequestId || "").replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return `subagent:${safeSession}:${safeRequest}`;
}

function mapSubagentDraft(sessionID, draft, now = Date.now()) {
  const payload = draft?.payload || {};
  switch (draft?.type) {
    case "tool.started":
      return {
        kind: "tool",
        id: payload.id || "",
        name: payload.name || "unknown",
        status: "running",
        input: payload.input || {},
        metadata: payload.metadata || {},
        title: payload.title || "",
        ts: now,
      };
    case "tool.done":
      return {
        kind: "tool",
        id: payload.id || "",
        status: payload.isError ? "failed" : (payload.status || "done"),
        result: payload.result ?? payload.content ?? null,
        metadata: payload.metadata || {},
        title: payload.title || "",
        ts: now,
      };
    case "assistant.delta":
      return { kind: "text", text: payload.text || "", ts: now };
    case "assistant.thinking.delta":
      return { kind: "thinking", text: payload.text || "", ts: now };
    case "usage.updated":
      return { kind: "usage", usage: payload.usage || {}, ts: now };
    case "permission.resolved":
      return {
        kind: "permission",
        status: "resolved",
        requestId: payload.requestId ? childRequestId(sessionID, payload.requestId) : "",
        rawRequestId: payload.requestId || "",
        ts: now,
      };
    case "user_question.resolved":
      return {
        kind: "question",
        status: "resolved",
        requestId: payload.requestId ? childRequestId(sessionID, payload.requestId) : "",
        rawRequestId: payload.requestId || "",
        ts: now,
      };
    default:
      return null;
  }
}

function createOpencodeSubagentRuntime(options = {}) {
  const getServer = options.getServer || (() => null);
  const getPermissionContext = options.getPermissionContext || (() => ({}));
  const pendingPermissions = options.pendingPermissions || new Map();
  const pendingQuestions = options.pendingQuestions || new Map();
  const ingest = options.ingest || (() => {});
  const onProgress = options.onProgress || (() => {});
  const now = options.now || (() => Date.now());
  const eventStates = new Map();
  const knownSessionIDs = new Set();

  function stateFor(sessionID) {
    const id = String(sessionID || "");
    if (!eventStates.has(id)) eventStates.set(id, createOpencodeRuntimeState());
    return eventStates.get(id);
  }

  function reset() {
    eventStates.clear();
    knownSessionIDs.clear();
  }

  function registerFromDrafts(drafts = []) {
    for (const draft of drafts) {
      if (!String(draft?.type || "").startsWith("tool.")) continue;
      const payload = draft.payload || {};
      if (String(payload.name || "").toLowerCase() !== "task" && draft.type !== "tool.done") continue;
      const meta = payload.metadata || {};
      const child = meta.sessionId || meta.sessionID;
      if (!child) continue;
      knownSessionIDs.add(String(child));
      getServer()?.allowChildSession?.(child);
    }
  }

  function mapEffect(sessionID, effect) {
    if (!effect || !sessionID) return null;
    const rawRequestId = effect.requestId || "";
    const requestId = rawRequestId ? childRequestId(sessionID, rawRequestId) : "";
    if (effect.kind === "error") {
      return {
        kind: "error",
        message: String(effect.message || "Engine error").slice(0, 600),
        ts: now(),
      };
    }
    if (effect.kind === "permission") {
      const permissionContext = getPermissionContext() || {};
      const verdict = decidePermission(
        permissionContext.mode || "ask",
        effect.toolName,
        effect.input || {},
        {
          cwd: permissionContext.cwd,
          taskContract: permissionContext.taskContract,
        },
      );
      if (verdict === "allow" || verdict === "deny") {
        const reply = verdict === "allow" ? "once" : "reject";
        void getServer()
          ?.respondPermission(rawRequestId, { reply }, { sessionID })
          .catch((err) => log.warn("subagent auto permission reply failed: %s", err?.message || err));
        return {
          kind: "permission",
          status: verdict === "allow" ? "auto_allowed" : "auto_denied",
          requestId,
          rawRequestId,
          toolName: effect.toolName || "",
          ts: now(),
        };
      }
      pendingPermissions.set(requestId, { rawRequestId, sessionID });
      ingest([{
        type: "permission.requested",
        payload: {
          requestId,
          toolName: effect.toolName,
          input: effect.input || {},
          title: effect.title || "",
          description: effect.description || "",
          decisionReason: effect.decisionReason || "",
          suggestions: effect.suggestions || [],
          planPreview: "",
          planPreviewTruncated: false,
          subagent: { sessionId: sessionID, rawRequestId },
        },
      }]);
      return { kind: "permission", status: "requested", requestId, rawRequestId, toolName: effect.toolName || "", ts: now() };
    }
    if (effect.kind === "question") {
      const questions = effect.questions || [];
      pendingQuestions.set(requestId, { questions, rawRequestId, sessionID });
      ingest([{
        type: "user_question.requested",
        payload: { requestId, questions, subagent: { sessionId: sessionID, rawRequestId } },
      }]);
      return { kind: "question", status: "requested", requestId, rawRequestId, ts: now() };
    }
    return null;
  }

  function handleEvent(sessionID, ev) {
    if (sessionID) knownSessionIDs.add(String(sessionID));
    let reduced;
    try {
      reduced = reduceOpencodeRuntimeEvent(ev, stateFor(sessionID));
    } catch (err) {
      log.warn("opencode subagent reducer failed: %s", err?.message || err);
      return;
    }
    if (reduced.progress) onProgress();
    const events = [];
    for (const effect of reduced.effects || []) {
      const mapped = mapEffect(sessionID, effect);
      if (mapped) events.push(mapped);
    }
    for (const draft of reduced.drafts || []) {
      const mapped = mapSubagentDraft(sessionID, draft, now());
      if (!mapped) continue;
      events.push(mapped);
      if (mapped.kind === "permission" && mapped.status === "resolved" && mapped.requestId) {
        ingest([{ type: "permission.resolved", payload: { requestId: mapped.requestId } }]);
      } else if (mapped.kind === "question" && mapped.status === "resolved" && mapped.requestId) {
        ingest([{ type: "user_question.resolved", payload: { requestId: mapped.requestId } }]);
      }
    }
    if (events.length) ingest([{ type: "subagent.event", payload: { sessionId: sessionID, events } }]);
  }

  return {
    handleEvent,
    hasKnownSubagents: () => knownSessionIDs.size > 0,
    registerFromDrafts,
    reset,
  };
}

module.exports = {
  childRequestId,
  createOpencodeSubagentRuntime,
  mapSubagentDraft,
};
