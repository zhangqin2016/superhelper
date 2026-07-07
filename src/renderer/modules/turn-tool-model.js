import { toolPreview } from "./turn-tool-preview.js";

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["grep", "glob"]);
const COMMAND_TOOLS = new Set(["bash"]);
const WEB_TOOLS = new Set(["websearch", "webfetch"]);
const AGENT_TOOLS = new Set(["task"]);
const TODO_TOOLS = new Set(["todowrite"]);

export function isTodoTool(name = "") {
  return TODO_TOOLS.has(String(name).toLowerCase());
}

// TodoWrite input is the model's plan; statuses outside the known set
// degrade to pending so a malformed item never hides the plan.
export function parseTodoEntries(tool = {}) {
  let input = tool.input;
  if ((!input || !Array.isArray(input.todos)) && tool.partialJson) {
    try {
      input = JSON.parse(tool.partialJson);
    } catch {
      return [];
    }
  }
  const todos = Array.isArray(input?.todos) ? input.todos : [];
  return todos
    .map((todo) => ({
      content: String(todo?.content || todo?.activeForm || "").trim(),
      status: normalizeTodoStatus(todo?.status),
    }))
    .filter((todo) => todo.content);
}

function normalizeTodoStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "in-progress" || value === "running" || value === "active") {
    return "in_progress";
  }
  return "pending";
}

export function classifyToolCategory(name = "") {
  const n = String(name).toLowerCase();
  if (READ_TOOLS.has(n)) return "read";
  if (WRITE_TOOLS.has(n)) return "write";
  if (SEARCH_TOOLS.has(n)) return "search";
  if (COMMAND_TOOLS.has(n)) return "command";
  if (WEB_TOOLS.has(n)) return "web";
  if (AGENT_TOOLS.has(n)) return "agent";
  return "other";
}

export function toolEntryToRenderTool(entry = {}) {
  return {
    id: entry.id,
    name: entry.name,
    input: entry.input || {},
    partialJson: entry.partialJson || "",
    status: entry.status || "done",
    result: entry.result || null,
    metadata: entry.metadata || {},
    title: entry.title || "",
  };
}

export function toolRowPreview(entry = {}) {
  return toolPreview(toolEntryToRenderTool(entry));
}

export function isFileWriteCategory(entry = {}) {
  return classifyToolCategory(entry.name) === "write";
}
