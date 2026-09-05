// Todo-progress nudge (plan-discipline layer) inside the OpenCode (Bun) serve.
//
// WHY: the model writes its task list once and then forgets it while it works —
// field case 2026-09-05: one todowrite, eight more tool calls, card stuck at 0/7.
// Claude Code fixes this with a system-reminder when TodoWrite goes quiet; this
// is the engine-agnostic equivalent: after N tool calls without a todowrite, append
// a one-line [plan] note to the tool result. The note NAMES the steps the
// execution record already supports (shared inference in lib/todo-progress.cjs),
// so a weak model only has to confirm — and asks for a STATUS-ONLY update so the
// list is not rewritten.
//
// Never rewrites the model's list itself (no-dumber invariant: the model keeps
// reasoning from its own state). FAIL OPEN: runs on every tool call, must never
// throw. Bounded memory (per-session window, LRU of sessions).
//
// Tunable: LILY_TODO_NUDGE=0 disables; LILY_TODO_NUDGE_AFTER (default 4) tool
// calls since the last todowrite before the first nudge, repeated every N.
import progress from "./lib/todo-progress.cjs";

const MAX_SESSIONS = 200;
const sessions = new Map(); // sessionID -> { todos, tools, since, lastNudge } (insertion order = LRU)

function envInt(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === "") return dflt;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function stateFor(sessionID) {
  let entry = sessions.get(sessionID);
  if (entry) {
    sessions.delete(sessionID);
  } else {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    entry = { todos: null, tools: [], since: 0, lastNudge: 0 };
  }
  sessions.set(sessionID, entry);
  return entry;
}

function normalizeTodos(args) {
  const todos = args && Array.isArray(args.todos) ? args.todos : null;
  if (!todos) return null;
  return todos
    .map((t) => ({
      content: String((t && (t.content || t.activeForm)) || "").trim(),
      status: String((t && t.status) || "pending").toLowerCase(),
    }))
    .filter((t) => t.content);
}

function unfinished(todos) {
  return todos.some((t) => t.status !== "completed" && t.status !== "cancelled");
}

function appendNote(output, note) {
  if (!output || typeof output !== "object") return;
  if (typeof output.output === "string") output.output = `${output.output}\n\n${note}`;
  else if (Array.isArray(output.content)) output.content.push({ type: "text", text: note });
}

export const TodoProgressNudgePlugin = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      if (process.env.LILY_TODO_NUDGE === "0") return;
      const tool = String((input && input.tool) || "");
      if (!tool) return;
      const state = stateFor(String((input && input.sessionID) || "default"));

      if (tool.toLowerCase() === "todowrite") {
        const todos = normalizeTodos(input.args);
        if (todos) {
          state.todos = todos;
          state.tools = [];
          state.since = 0;
          state.lastNudge = 0;
        }
        return;
      }

      // Record BEFORE deciding, from the raw result — our own note never feeds
      // the next inference.
      const record = progress.compactTool({
        id: String((input && input.callID) || ""),
        name: tool,
        input: input && input.args,
        output,
        status: "done",
      });
      // The engine hands failed tool runs to the hook too; a result that opens
      // with an error marker must not count as evidence of success.
      if (/^\s*(error|failed|exception|traceback)\b/i.test(record.outputText)) record.ok = false;
      state.tools.push(record);
      if (state.tools.length > progress.MAX_TOOLS) state.tools.shift();
      state.since += 1;

      if (!state.todos || !state.todos.length || !unfinished(state.todos)) return;
      const after = envInt("LILY_TODO_NUDGE_AFTER", 4);
      if (state.since < after || state.since - state.lastNudge < after) return;

      const inference = progress.inferPlanProgress(state.todos, state.tools);
      const note = progress.buildNudgeNote({
        locale: process.env.LILY_LOCALE || "en",
        sinceCount: state.since,
        steps: state.todos,
        inference,
      });
      appendNote(output, note);
      state.lastNudge = state.since;
    } catch {
      /* fail open — a progress reminder must never break a turn */
    }
  },
});

export default TodoProgressNudgePlugin;
