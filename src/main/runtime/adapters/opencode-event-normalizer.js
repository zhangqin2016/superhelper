"use strict";

/**
 * Translate OpenCode INSTANCE-API SSE events into the engine-agnostic action
 * vocabulary the rest of the app consumes (same kinds claude-event-normalizer
 * produces). The renderer + agent-session state machine stay engine-neutral.
 *
 * Event format (verified live against opencode-ai 1.17.8, instance `/event`):
 *   envelope:  { id, type, properties }            // payload is in `properties`
 *   streaming: message.part.delta { messageID, partID, field:"text"|"reasoning", delta }
 *   parts:     message.part.updated properties.part:
 *                { type:"text", text }                         (full text; dup of deltas / user echo)
 *                { type:"tool", tool, callID, state:{ status:"running"|"completed"|"error", input, metadata:{output}, output } }
 *                { type:"step-finish", tokens, cost }
 *   turn end:  session.idle  OR  session.status properties.status.type==="idle"
 *   permission:permission.updated
 *
 * Tool calls arrive as repeated message.part.updated for one callID as its state
 * advances; we de-dup via `state.tools` (callID -> "started"|"done") so the host
 * sees exactly one tool_use and one tool_result.
 */

/** Flatten a tool part's completed state into the plain string tool_result carries. */
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

function toolActions(part, state) {
  const callID = part.callID || part.id || "";
  if (!callID) return [];
  const st = part.state || {};
  const status = st.status || "";
  const input = st.input && typeof st.input === "object" ? st.input : {};
  const hasInput = Object.keys(input).length > 0;
  const prev = state.tools.get(callID);
  const out = [];

  const started = () => {
    state.tools.set(callID, "started");
    out.push({
      kind: "assistant_tool_use",
      id: callID,
      name: part.tool || "unknown",
      input,
      parentToolUseId: null,
      subagentType: "",
      taskDescription: "",
    });
  };

  // Emit the tool_use once args are actually present (the first "running" event
  // can arrive before them) so the rendered call is never blank.
  if (!prev && (status === "running" || status === "pending") && hasInput) started();

  if ((status === "completed" || status === "error") && prev !== "done") {
    if (!prev) started(); // tool we never saw begin — synthesize the start first
    state.tools.set(callID, "done");
    out.push({
      kind: "tool_result",
      id: callID,
      isError: status === "error",
      content: stringifyToolOutput(st),
    });
  }
  return out;
}

/** Event types we intentionally ignore (duplicates of message.part.* or noise). */
const SILENT = new Set([
  "server.connected", "server.heartbeat", "session.created", "session.updated",
  "session.diff", "message.updated", "plugin.added", "catalog.updated",
  "integration.updated", "reference.updated", "text", "tool", "busy",
  "step-start", "session.next.model.switched", "session.next.agent.switched",
  "session.next.prompt.admitted",
]);

/**
 * @param {{ type?: string, properties?: Record<string, unknown> }} ev
 * @param {{ tools: Map<string,string> }} [state] cross-event state for tool de-dup.
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeOpencodeEvent(ev, state = { tools: new Map(), parts: new Map() }) {
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return [];
  if (SILENT.has(ev.type)) return [];
  const p = ev.properties || {};

  switch (ev.type) {
    case "message.part.delta": {
      const delta = p.delta || "";
      if (!delta) return [];
      // The provider mislabels reasoning deltas as field:"text" (deepseek-v4-pro
      // via the Anthropic endpoint), so reasoning leaks into the answer. Trust the
      // owning PART's type (recorded from message.part.updated) over the field.
      const partType = p.partID && state.parts ? state.parts.get(p.partID) : null;
      const isReasoning = partType === "reasoning" || (!partType && p.field === "reasoning");
      if (partType === "text" || p.field === "text" || isReasoning) {
        return [{ kind: isReasoning ? "assistant_thinking" : "assistant_text", text: delta }];
      }
      return [];
    }

    case "message.part.updated": {
      const part = p.part || {};
      // Record partID -> type so deltas can be classified correctly (above).
      if (part.id && part.type && state.parts) state.parts.set(part.id, part.type);
      if (part.type === "tool") return toolActions(part, state);
      if (part.type === "step-finish") {
        // Carry token usage on the engine-agnostic stream_message_delta action so
        // runtimeEventFromAction surfaces usage.updated to the renderer; the host
        // also records it for cost. OpenCode tokens: {input,output,reasoning,cache:{read,write}}.
        const tk = part.tokens || {};
        const cache = tk.cache || {};
        return [{
          kind: "stream_message_delta",
          stopReason: part.reason || "",
          usage: {
            input_tokens: tk.input || 0,
            output_tokens: (tk.output || 0) + (tk.reasoning || 0),
            cache_read_input_tokens: cache.read || 0,
            cache_creation_input_tokens: cache.write || 0,
          },
          cost: part.cost || 0,
        }];
      }
      // text parts duplicate the streamed deltas (and echo the user prompt).
      return [];
    }

    // Turn completion — the instance loop goes idle when the turn is done.
    case "session.idle":
    case "idle":
      return [{ kind: "turn_result", event: { subtype: "success", is_error: false } }];
    case "session.status":
      return p.status && p.status.type === "idle"
        ? [{ kind: "turn_result", event: { subtype: "success", is_error: false } }]
        : [];

    // The `question` tool raises a structured multiple-choice prompt.
    // { id, questions:[{question, header, options:[{label,description}], multiple, custom}], tool:{callID} }
    case "question.asked":
      return [{
        kind: "ask_user_question",
        requestId: p.id || "",
        input: {
          questions: (Array.isArray(p.questions) ? p.questions : []).map((q) => ({
            question: q.question || "",
            header: q.header || "",
            options: Array.isArray(q.options) ? q.options : [],
            multiSelect: Boolean(q.multiple),
            allowCustom: Boolean(q.custom),
          })),
        },
        callId: (p.tool && p.tool.callID) || "",
      }];

    case "session.error":
    case "message.error": {
      const err = p.error || p;
      return [{ kind: "runtime_error", event: { message: (err && err.message) || "Engine error" } }];
    }

    // The instance API asks for tool approval via `permission.asked`. Shape:
    // { id, permission:"bash", patterns, metadata:{command,description}, always, tool:{callID,messageID} }
    case "permission.asked":
    case "permission.updated":
      return [{
        kind: "permission_check",
        requestId: p.id || p.permissionID || "",
        toolName: p.permission || (p.tool && p.tool.name) || p.type || "unknown",
        input: (p.metadata && typeof p.metadata === "object" ? p.metadata : {}),
        title: p.title || "",
        description: (p.metadata && p.metadata.description) || p.description || "",
        decisionReason: "",
        suggestions: [],
        callId: (p.tool && p.tool.callID) || p.callID || "",
      }];

    default:
      return [{
        kind: "unknown_runtime_event",
        event: ev,
        notice: { code: "unknownEvent", level: "warning", panel: true, done: true, type: ev.type },
      }];
  }
}

module.exports = { normalizeOpencodeEvent, stringifyToolOutput };
