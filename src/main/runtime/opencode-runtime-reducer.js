"use strict";

/**
 * OpenCode INSTANCE API event reducer.
 *
 * This is intentionally OpenCode-specific: raw server events are reduced
 * directly into Lily runtime drafts plus the small set of host-side effects the
 * session runner must perform. There is no Claude-style action vocabulary in
 * this path.
 */

const { OPENCODE_RUNTIME_CAPABILITIES } = require("./runtime-capabilities");

const SILENT_EVENTS = new Set([
  "server.connected",
  "server.heartbeat",
  "session.created",
  "session.updated",
  "session.diff",
  "plugin.added",
  "catalog.updated",
  "integration.updated",
  "reference.updated",
  "text",
  "tool",
  "busy",
  "step-start",
  "session.next.model.switched",
  "session.next.agent.switched",
  "session.next.prompt.admitted",
]);

function createOpencodeRuntimeState() {
  return {
    tools: new Map(),
    parts: new Map(),
    partMessages: new Map(),
    roles: new Map(),
    textParts: new Map(),
    pendingDeltas: new Map(),
    pendingTextSnapshots: new Map(),
  };
}

function requestId(payload = {}) {
  return payload.id || payload.requestID || payload.permissionID || payload.questionID || "";
}

function sessionScopedId(prefix, payload = {}) {
  return `${prefix}_${payload.sessionID || payload.sessionId || "current"}`;
}

function resetOpencodeRuntimeState(state) {
  state?.tools?.clear?.();
  state?.parts?.clear?.();
  state?.partMessages?.clear?.();
  state?.roles?.clear?.();
  state?.textParts?.clear?.();
  state?.pendingDeltas?.clear?.();
  state?.pendingTextSnapshots?.clear?.();
}

function runtimeDraft(type, payload = {}) {
  return {
    type,
    source: "opencode",
    payload,
  };
}

function stringifyToolOutput(state = {}) {
  if (typeof state.output === "string" && state.output) return state.output;
  const meta = state.metadata || {};
  if (typeof meta.output === "string" && meta.output) return meta.output;
  if (state.error) return typeof state.error === "string" ? state.error : (state.error.message || "");
  try {
    return Object.keys(meta).length ? JSON.stringify(meta) : "";
  } catch {
    return "";
  }
}

function stringifyToolContent(content) {
  if (!Array.isArray(content) || !content.length) return "";
  const out = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") out.push(item.text);
    else if (typeof item.content === "string") out.push(item.content);
    else if (typeof item.value === "string") out.push(item.value);
  }
  return out.join("\n").trim();
}

function stringifySessionNextToolOutput(payload = {}) {
  const content = stringifyToolContent(payload.content);
  if (content) return content;
  const result = payload.result;
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    for (const key of ["output", "content", "text", "summary", "message"]) {
      if (typeof result[key] === "string" && result[key]) return result[key];
    }
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
  if (payload.error) return errorMessage(payload.error);
  return "";
}

function compactToolMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function toolMetadataFromProperties(p = {}) {
  return compactToolMetadata(p.metadata || p.provider?.metadata || {});
}

function toolMetadataFromPart(part = {}) {
  const state = part.state || {};
  return compactToolMetadata(state.metadata || part.metadata || {});
}

function errorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  if (typeof error.data?.message === "string" && error.data.message) return error.data.message;
  if (typeof error.cause?.message === "string" && error.cause.message) return error.cause.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "";
  }
}

function reduceSessionNextToolEvent(ev, state) {
  const p = ev.properties || {};
  const callID = p.callID || p.id || "";
  if (!callID) return { drafts: [], progress: false };
  const previous = state.tools.get(callID);
  const drafts = [];
  const start = () => {
    state.tools.set(callID, "started");
    drafts.push(runtimeDraft("tool.started", {
      id: callID,
      name: p.tool || p.name || "unknown",
      input: p.input && typeof p.input === "object" ? p.input : {},
      metadata: toolMetadataFromProperties(p),
      title: p.title || p.metadata?.title || "",
      parentToolUseId: null,
    }));
  };

  if (ev.type === "session.next.tool.called") {
    if (!previous) start();
    return { drafts, progress: true };
  }

  if (ev.type === "session.next.tool.progress") {
    if (!previous) start();
    return { drafts, progress: true };
  }

  if ((ev.type === "session.next.tool.success" || ev.type === "session.next.tool.failed") && previous !== "done") {
    if (!previous) start();
    state.tools.set(callID, "done");
    drafts.push(runtimeDraft("tool.done", {
      id: callID,
      isError: ev.type === "session.next.tool.failed",
      content: stringifySessionNextToolOutput(p),
      metadata: toolMetadataFromProperties(p),
      title: p.title || p.metadata?.title || "",
    }));
    return { drafts, progress: true };
  }

  return { drafts: [], progress: false };
}

function reduceToolPart(part, state) {
  const callID = part.callID || part.id || "";
  if (!callID) return { drafts: [], progress: false };
  const st = part.state || {};
  const status = st.status || "";
  const input = st.input && typeof st.input === "object" ? st.input : {};
  const hasInput = Object.keys(input).length > 0;
  const prev = state.tools.get(callID);
  const drafts = [];

  const started = () => {
    state.tools.set(callID, "started");
    drafts.push(runtimeDraft("tool.started", {
      id: callID,
      name: part.tool || "unknown",
      input,
      metadata: toolMetadataFromPart(part),
      title: st.title || part.title || "",
      parentToolUseId: null,
    }));
  };

  if (!prev && (status === "running" || status === "pending") && hasInput) started();

  if ((status === "completed" || status === "error") && prev !== "done") {
    if (!prev) started();
    state.tools.set(callID, "done");
    drafts.push(runtimeDraft("tool.done", {
      id: callID,
      isError: status === "error",
      content: stringifyToolOutput(st),
      metadata: toolMetadataFromPart(part),
      title: st.title || part.title || "",
    }));
  }

  return { drafts, progress: drafts.length > 0 };
}

function compactEvent(ev) {
  if (!ev || typeof ev !== "object") return {};
  const p = ev.properties && typeof ev.properties === "object" ? ev.properties : {};
  const out = {
    type: ev.type || "",
    id: ev.id || "",
  };
  if (p.sessionID) out.sessionID = p.sessionID;
  if (p.messageID) out.messageID = p.messageID;
  if (p.partID) out.partID = p.partID;
  if (p.field) out.field = p.field;
  if (p.status) out.status = p.status;
  if (p.part?.type) out.partType = p.part.type;
  if (p.part?.tool) out.tool = p.part.tool;
  if (p.error) out.error = p.error;
  return out;
}

function processSummary(ev, effects, drafts) {
  const firstEffect = effects.find((effect) => effect.kind !== "usage");
  if (firstEffect?.kind === "assistant_text") return firstEffect.text || "";
  if (firstEffect?.kind === "assistant_thinking") return firstEffect.text || "";
  if (firstEffect?.kind === "permission") return firstEffect.toolName || "";
  if (firstEffect?.kind === "question") return "question";
  const firstDraft = drafts[0];
  if (firstDraft?.type === "tool.started") return firstDraft.payload?.name || "";
  if (firstDraft?.type === "tool.done") return firstDraft.payload?.id || "";
  if (firstDraft?.type === "todo.updated") return "todo";
  return SILENT_EVENTS.has(ev?.type) ? "" : String(ev?.type || "");
}

function processEventDraft(ev, result) {
  const payload = {
    rawType: String(ev?.type || ""),
    rawSubtype: "",
    effects: result.effects.map((effect) => ({
      kind: effect.kind || "",
      id: effect.requestId || effect.id || "",
      name: effect.toolName || "",
      text: effect.text || "",
      input: effect.input || null,
      result: effect.content || null,
      stopReason: effect.stopReason || "",
    })),
    event: compactEvent(ev),
    rawEvent: ev && typeof ev === "object" ? ev : null,
    handled: !result.effects.some((effect) => effect?.kind === "unknown"),
  };
  payload.summary = processSummary(ev, result.effects, result.drafts);
  return runtimeDraft("process.event", payload);
}

function emptyResult(ev) {
  const result = {
    drafts: [],
    effects: [],
    progress: false,
    terminal: false,
  };
  result.processEvent = processEventDraft(ev, result);
  return result;
}

function quietResult(ev) {
  return {
    drafts: [],
    effects: [],
    progress: false,
    terminal: false,
    processEvent: runtimeDraft("process.event", {
      rawType: String(ev?.type || ""),
      rawSubtype: "",
      effects: [],
      event: compactEvent(ev),
      summary: "",
    }),
  };
}

function withProcessEvent(ev, result) {
  result.processEvent = processEventDraft(ev, result);
  return result;
}

/**
 * @param {{ type?: string, properties?: Record<string, unknown> }} ev
 * @param {{ tools: Map<string,string>, parts: Map<string,string> }} state
 */
function reduceOpencodeRuntimeEvent(ev, state = createOpencodeRuntimeState()) {
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return emptyResult(ev);
  if (SILENT_EVENTS.has(ev.type)) return emptyResult(ev);
  const p = ev.properties || {};

  switch (ev.type) {
    case "message.updated": {
      const info = p.info || {};
      if (info.id && info.role && state.roles) state.roles.set(info.id, info.role);
      if (info.id && info.role && state.pendingTextSnapshots?.size) {
        const drafts = [];
        const effects = [];
        for (const [partID, snapshot] of state.pendingTextSnapshots.entries()) {
          if (snapshot.messageID !== info.id) continue;
          state.pendingTextSnapshots.delete(partID);
          if (info.role === "user") {
            state.textParts?.set(partID, snapshot.text || "");
            continue;
          }
          if (info.role !== "assistant") continue;
          const text = snapshot.text || "";
          const previous = state.textParts?.get(partID) || "";
          let missing = "";
          if (text && text.startsWith(previous)) missing = text.slice(previous.length);
          else if (text && !previous) missing = text;
          if (!missing) continue;
          state.textParts?.set(partID, text);
          drafts.push(runtimeDraft("assistant.delta", { text: missing }));
          effects.push({ kind: "assistant_text", text: missing });
        }
        if (drafts.length) {
          return withProcessEvent(ev, {
            drafts,
            effects,
            progress: true,
            terminal: false,
          });
        }
      }
      return emptyResult(ev);
    }

    case "session.deleted":
      return emptyResult(ev);

    case "message.removed":
      if (p.messageID && state.roles) state.roles.delete(p.messageID);
      if (p.messageID && state.partMessages) {
        for (const [partID, messageID] of state.partMessages.entries()) {
          if (messageID !== p.messageID) continue;
          state.parts?.delete(partID);
          state.partMessages?.delete(partID);
          state.textParts?.delete(partID);
          state.pendingDeltas?.delete(partID);
          state.pendingTextSnapshots?.delete(partID);
        }
      }
      return emptyResult(ev);

    case "message.part.delta": {
      const delta = p.delta || "";
      if (!delta) return emptyResult(ev);
      const partType = p.partID && state.parts ? state.parts.get(p.partID) : null;
      const isReasoning = partType === "reasoning" || (!partType && p.field === "reasoning");
      if (p.partID && p.messageID && state.partMessages) state.partMessages.set(p.partID, p.messageID);
      if (p.partID && !partType && p.field === "text") {
        state.pendingDeltas?.set(p.partID, `${state.pendingDeltas.get(p.partID) || ""}${delta}`);
        return quietResult(ev);
      }
      if (partType !== "text" && p.field !== "text" && !isReasoning) return emptyResult(ev);
      if (p.partID && state.textParts) {
        state.textParts.set(p.partID, `${state.textParts.get(p.partID) || ""}${delta}`);
      }
      const type = isReasoning ? "assistant.thinking.delta" : "assistant.delta";
      const kind = isReasoning ? "assistant_thinking" : "assistant_text";
      return withProcessEvent(ev, {
        drafts: [runtimeDraft(type, { text: delta })],
        effects: [{ kind, text: delta }],
        progress: true,
        terminal: false,
      });
    }

    case "message.part.updated": {
      const part = p.part || {};
      if (part.id && part.type && state.parts) state.parts.set(part.id, part.type);
      if (part.id && part.messageID && state.partMessages) state.partMessages.set(part.id, part.messageID);
      if (part.type === "tool") {
        const tool = reduceToolPart(part, state);
        return withProcessEvent(ev, {
          drafts: tool.drafts,
          effects: [],
          progress: tool.progress,
          terminal: false,
        });
      }
      if (part.type === "step-finish") {
        const tk = part.tokens || {};
        const cache = tk.cache || {};
        const usage = {
          input_tokens: tk.input || 0,
          output_tokens: (tk.output || 0) + (tk.reasoning || 0),
          cache_read_input_tokens: cache.read || 0,
          cache_creation_input_tokens: cache.write || 0,
        };
        return withProcessEvent(ev, {
          drafts: [runtimeDraft("usage.updated", { usage, stopReason: part.reason || "" })],
          effects: [{ kind: "usage", usage, stopReason: part.reason || "", cost: part.cost || 0 }],
          progress: true,
          terminal: false,
        });
      }
      if (part.type === "text" || part.type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : "";
        if (!part.id) return emptyResult(ev);
        const messageID = part.messageID || state.partMessages?.get(part.id) || "";
        const role = messageID ? state.roles?.get(messageID) : "";
        if (part.type === "text" && role === "user") {
          state.textParts?.set(part.id, text);
          state.pendingDeltas?.delete(part.id);
          state.pendingTextSnapshots?.delete(part.id);
          return emptyResult(ev);
        }
        if (part.type === "text" && !role && text) {
          state.pendingTextSnapshots?.set(part.id, { messageID, text });
          return emptyResult(ev);
        }
        const previous = state.textParts?.get(part.id) || "";
        const pending = state.pendingDeltas?.get(part.id) || "";
        let missing = "";
        if (text && text.startsWith(previous)) {
          missing = text.slice(previous.length);
        } else if (text && !previous && role === "assistant") {
          missing = text;
        } else if (!text && pending) {
          missing = pending;
        }
        state.pendingDeltas?.delete(part.id);
        state.pendingTextSnapshots?.delete(part.id);
        state.textParts?.set(part.id, text || `${previous}${missing}`);
        if (!missing) return emptyResult(ev);
        const isReasoning = part.type === "reasoning";
        return withProcessEvent(ev, {
          drafts: [runtimeDraft(isReasoning ? "assistant.thinking.delta" : "assistant.delta", { text: missing })],
          effects: [{ kind: isReasoning ? "assistant_thinking" : "assistant_text", text: missing }],
          progress: true,
          terminal: false,
        });
      }
      return emptyResult(ev);
    }

    case "session.next.tool.called":
    case "session.next.tool.progress":
    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const tool = reduceSessionNextToolEvent(ev, state);
      return withProcessEvent(ev, {
        drafts: tool.drafts,
        effects: [],
        progress: tool.progress,
        terminal: false,
      });
    }

    case "session.next.step.ended": {
      const tk = p.tokens || {};
      const cache = tk.cache || {};
      const usage = {
        input_tokens: tk.input || 0,
        output_tokens: (tk.output || 0) + (tk.reasoning || 0),
        cache_read_input_tokens: cache.read || 0,
        cache_creation_input_tokens: cache.write || 0,
      };
      return withProcessEvent(ev, {
        drafts: [runtimeDraft("usage.updated", { usage, stopReason: p.finish || "" })],
        effects: [{ kind: "usage", usage, stopReason: p.finish || "", cost: p.cost || 0 }],
        progress: true,
        terminal: false,
      });
    }

    case "session.next.step.failed": {
      return withProcessEvent(ev, {
        drafts: [],
        effects: [{ kind: "error", message: errorMessage(p.error) || "Engine error" }],
        progress: true,
        terminal: true,
      });
    }

    case "message.part.removed":
      if (p.partID) {
        state.parts?.delete(p.partID);
        state.partMessages?.delete(p.partID);
        state.textParts?.delete(p.partID);
        state.pendingDeltas?.delete(p.partID);
        state.pendingTextSnapshots?.delete(p.partID);
      }
      return emptyResult(ev);

    case "todo.updated": {
      const todos = Array.isArray(p.todos) ? p.todos : [];
      return withProcessEvent(ev, {
        drafts: [runtimeDraft("todo.updated", {
          id: sessionScopedId("todo", p),
          todos,
        })],
        effects: [],
        progress: true,
        terminal: false,
      });
    }

    case "session.idle":
    case "idle":
      return withProcessEvent(ev, {
        drafts: [],
        effects: [{ kind: "complete", code: 0 }],
        progress: true,
        terminal: true,
      });

    case "session.status":
      // Status is a snapshot, not a turn boundary. On the shared async server it
      // can arrive before the final message deltas have drained; only the real
      // session.idle event is allowed to close the turn.
      return withProcessEvent(ev, {
        drafts: [],
        effects: [],
        progress: false,
        terminal: false,
      });

    case "session.compacted":
      return withProcessEvent(ev, {
        drafts: [runtimeDraft("engine.notice", {
          notice: {
            code: "compactComplete",
            level: "info",
            panel: true,
            done: true,
            detail: "Conversation context was compacted.",
          },
        })],
        effects: [{
          kind: "context_compacted",
          reason: p.reason || "",
          sessionID: p.sessionID || p.sessionId || "",
          messageID: p.messageID || p.messageId || "",
        }],
        progress: true,
        terminal: false,
      });

    case "question.asked": {
      const questions = (Array.isArray(p.questions) ? p.questions : []).map((q) => ({
        question: q.question || "",
        header: q.header || "",
        options: Array.isArray(q.options) ? q.options : [],
        multiSelect: Boolean(q.multiple),
        allowCustom: Boolean(q.custom),
      }));
      return withProcessEvent(ev, {
        drafts: [],
        effects: [{
          kind: "question",
          requestId: p.id || "",
          questions,
          callId: p.tool?.callID || "",
        }],
        progress: true,
        terminal: false,
      });
    }

    case "question.replied":
    case "question.rejected":
      return withProcessEvent(ev, {
        drafts: [runtimeDraft("user_question.resolved", {
          requestId: requestId(p),
          rejected: ev.type === "question.rejected",
        })],
        effects: [],
        progress: true,
        terminal: false,
      });

    case "permission.asked":
    case "permission.updated":
      return withProcessEvent(ev, {
        drafts: [],
        effects: [{
          kind: "permission",
          requestId: p.id || p.permissionID || "",
          toolName: p.permission || p.tool?.name || p.type || "unknown",
          input: p.metadata && typeof p.metadata === "object" ? p.metadata : {},
          title: p.title || "",
          description: p.metadata?.description || p.description || "",
          decisionReason: "",
          suggestions: [],
          callId: p.tool?.callID || p.callID || "",
        }],
        progress: true,
        terminal: false,
      });

    case "permission.replied":
      return withProcessEvent(ev, {
        drafts: [runtimeDraft("permission.resolved", {
          requestId: requestId(p),
          allow: p.allow,
          answer: p.answer,
          cancelled: false,
        })],
        effects: [],
        progress: true,
        terminal: false,
      });

    case "vcs.branch.updated":
    case "lsp.updated":
    case "server.instance.disposed":
      return emptyResult(ev);

    case "session.error":
    case "message.error": {
      const err = p.error || p;
      return withProcessEvent(ev, {
        drafts: [],
        effects: [{ kind: "error", message: errorMessage(err) || "Engine error" }],
        progress: true,
        terminal: true,
      });
    }

    default:
      return withProcessEvent(ev, {
        drafts: [],
        effects: [{ kind: "unknown", type: ev.type }],
        progress: false,
        terminal: false,
      });
  }
}

module.exports = {
  OPENCODE_RUNTIME_CAPABILITIES,
  SILENT_EVENTS,
  createOpencodeRuntimeState,
  resetOpencodeRuntimeState,
  reduceOpencodeRuntimeEvent,
  stringifyToolOutput,
};
