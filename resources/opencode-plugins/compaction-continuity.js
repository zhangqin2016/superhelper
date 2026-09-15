// Compaction continuity (long-task layer) inside the OpenCode (Bun) serve.
//
// WHY (2026-09-15 long-task audit): an in-turn auto-compaction creates a new
// user message that carries NO `system` (the overflow-replay path copies it,
// the compaction path does not — engine session/compaction.ts `create`). Every
// model step after that runs without Lily's per-turn guidance (skills, tool
// protocol, autonomy rules), and the turn's own user request + acceptance
// criteria sit structurally in the summarized head. `question` answers and the
// todo list live only in tool outputs that the prune pass may clear.
//
// This plugin closes those holes without patching the engine binary:
//   1. chat.messages.transform — remembers the last real user `system` per
//      session (memory, then the on-disk handoff file as a cross-restart
//      fallback) and re-attaches it — plus a bounded task anchor (original
//      request, acceptance criteria, live todo list) — to the compaction user
//      message once its summary exists. The engine holds the SAME info object
//      it passes as `user` to the model call, so the field is set in place on
//      `info` on purpose; parts are only ever copied.
//   2. chat.messages.transform — restores pruned `question`/`todowrite`
//      outputs from the plugin's own cache on COPIES of the affected parts.
//   3. session.compacting — appends the task anchor to the compaction prompt so
//      the summary keeps the request/acceptance/todos verbatim.
//
// FAIL OPEN: never throws; on anything unexpected the engine default applies.
// Kill switch: LILY_COMPACTION_CONTINUITY=0.
import fs from "node:fs";
import path from "node:path";

const MAX_SESSIONS = 200;
const MAX_OUTPUTS_PER_SESSION = 64;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_GUIDANCE_CHARS = 60_000;
const MAX_ANCHOR_CHARS = 1_400;
const PROTECTED_TOOLS = new Set(["question", "todowrite", "todoread"]);
const ANCHOR_HEADER = "[Lily task anchor — 当前回合的原始请求与验收标准（压缩后仍然有效，必须据此收尾）]";
const ANCHOR_PRESERVE =
  "以下是当前任务的锚点。生成摘要时：Objective 必须原样保留原始请求与验收标准（不得概括），" +
  "Work State 必须逐条列出待办及其状态，Relevant Files 必须保留已改动文件的完整路径。";

const sessions = new Map(); // sessionID -> { guidance, todos, outputs: Map }

function enabled() {
  return process.env.LILY_COMPACTION_CONTINUITY !== "0";
}

function stateFor(sessionID) {
  const key = String(sessionID || "default");
  let entry = sessions.get(key);
  if (entry) sessions.delete(key);
  else {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    entry = { guidance: "", todos: null, outputs: new Map() };
  }
  sessions.set(key, entry);
  return entry;
}

function readHandoff(sessionID) {
  const dir = process.env.LILY_COMPACTION_MEMORY_DIR || "";
  const id = String(sessionID || "");
  if (!dir || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function clip(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeTodos(args) {
  const todos = args && Array.isArray(args.todos) ? args.todos : null;
  if (!todos) return null;
  return todos
    .map((t) => ({ content: clip((t && (t.content || t.activeForm)) || "", 160), status: String((t && t.status) || "pending").toLowerCase() }))
    .filter((t) => t.content)
    .slice(0, 20);
}

/** Bounded anchor text from the on-disk anchor + the live todo list. */
export function buildAnchorText(anchor, todos, limit = MAX_ANCHOR_CHARS) {
  const lines = [];
  if (anchor && typeof anchor === "object") {
    if (anchor.request) lines.push(`原始请求：${clip(anchor.request, 600)}`);
    const criteria = Array.isArray(anchor.successCriteria) ? anchor.successCriteria.filter(Boolean).slice(0, 6) : [];
    if (criteria.length) lines.push("验收标准：", ...criteria.map((c) => `- ${clip(c, 160)}`));
    const deliverables = Array.isArray(anchor.deliverables) ? anchor.deliverables.filter(Boolean).slice(0, 6) : [];
    if (deliverables.length) lines.push(`要求交付：${deliverables.map((d) => clip(d, 120)).join("；")}`);
  }
  if (Array.isArray(todos) && todos.length) {
    const mark = { completed: "[x]", in_progress: "[~]", cancelled: "[-]" };
    lines.push("待办清单（模型自己的列表，按状态接着做）：", ...todos.map((t) => `${mark[t.status] || "[ ]"} ${t.content}`));
  }
  let text = lines.join("\n");
  if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
  return text;
}

function isAfter(info, other) {
  if (!other) return true;
  const a = Number(info?.time?.created || 0);
  const b = Number(other?.time?.created || 0);
  if (a !== b) return a > b;
  return String(info?.id || "") > String(other?.id || "");
}

function hasCompactionPart(message) {
  return Array.isArray(message?.parts) && message.parts.some((part) => part && part.type === "compaction");
}

function outputText(output) {
  if (!output || typeof output !== "object") return "";
  if (typeof output.output === "string") return output.output;
  if (Array.isArray(output.content)) return output.content.filter((c) => c && c.type === "text").map((c) => String(c.text || "")).join("\n");
  return "";
}

function restorePrunedOutputs(messages, state) {
  if (!state.outputs.size) return;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const parts = Array.isArray(message?.parts) ? message.parts : null;
    if (!parts) continue;
    let replaced = null;
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j];
      if (!part || part.type !== "tool" || !PROTECTED_TOOLS.has(String(part.tool || ""))) continue;
      const st = part.state;
      if (!st || st.status !== "completed" || !st.time || !st.time.compacted) continue;
      const cached = state.outputs.get(String(part.callID || ""));
      if (!cached) continue;
      const { compacted: _dropped, ...time } = st.time;
      replaced = replaced || parts.slice();
      replaced[j] = { ...part, state: { ...st, output: cached, time } };
    }
    if (replaced) messages[i] = { ...message, parts: replaced };
  }
}

export const CompactionContinuityPlugin = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      if (!enabled()) return;
      const tool = String((input && input.tool) || "").toLowerCase();
      if (!PROTECTED_TOOLS.has(tool)) return;
      const state = stateFor(input && input.sessionID);
      if (tool === "todowrite") {
        const todos = normalizeTodos(input.args);
        if (todos) state.todos = todos;
      }
      const text = outputText(output);
      const callID = String((input && input.callID) || "");
      if (!callID || !text) return;
      if (state.outputs.size >= MAX_OUTPUTS_PER_SESSION) state.outputs.delete(state.outputs.keys().next().value);
      state.outputs.set(callID, text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text);
    } catch {
      /* fail open */
    }
  },

  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      if (!enabled()) return;
      const messages = output && Array.isArray(output.messages) ? output.messages : null;
      if (!messages || !messages.length) return;
      const sessionID = messages.find((m) => m && m.info && m.info.sessionID)?.info.sessionID;
      const state = stateFor(sessionID);

      // 1. Remember the newest real user `system` (Lily's per-turn guidance).
      let latestUser = null;
      let latestGuided = null;
      for (const message of messages) {
        const info = message && message.info;
        if (!info || info.role !== "user") continue;
        if (isAfter(info, latestUser && latestUser.info)) latestUser = message;
        if (!hasCompactionPart(message) && typeof info.system === "string" && info.system.trim()
          && isAfter(info, latestGuided && latestGuided.info)) latestGuided = message;
      }
      if (latestGuided) state.guidance = latestGuided.info.system.slice(0, MAX_GUIDANCE_CHARS);

      // 2. Pruned question/todo outputs come back (copies only).
      restorePrunedOutputs(messages, state);

      // 3. The continuation call after a compaction: re-attach guidance + anchor.
      if (!latestUser || !hasCompactionPart(latestUser)) return;
      const info = latestUser.info;
      if (typeof info.system === "string" && info.system.trim()) return;
      const summarized = messages.some((m) => m && m.info && m.info.role === "assistant" && m.info.summary === true
        && (m.info.parentID === info.id || isAfter(m.info, info)));
      if (!summarized) return; // the summarizer's own call: keep it lean
      const handoff = readHandoff(sessionID);
      const guidance = state.guidance || (handoff && typeof handoff.guidance === "string" ? handoff.guidance.slice(0, MAX_GUIDANCE_CHARS) : "");
      const anchor = buildAnchorText(handoff && handoff.anchor, state.todos);
      const system = [guidance, anchor ? `${ANCHOR_HEADER}\n${anchor}` : ""].filter(Boolean).join("\n\n");
      if (system) info.system = system; // same object the engine passes as `user` — see header
    } catch {
      /* fail open */
    }
  },

  "experimental.session.compacting": async (input, output) => {
    try {
      if (!enabled() || !output) return;
      const sessionID = input && input.sessionID;
      const anchor = buildAnchorText(readHandoff(sessionID)?.anchor, stateFor(sessionID).todos);
      if (!anchor) return;
      const existing = Array.isArray(output.context) ? output.context : [];
      output.context = [...existing, `${ANCHOR_PRESERVE}\n${anchor}`];
    } catch {
      /* fail open */
    }
  },
});

export default CompactionContinuityPlugin;
