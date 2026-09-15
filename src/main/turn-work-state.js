"use strict";

/**
 * Concrete work state of a turn, for the prompt that continues it.
 *
 * The continuation prompt used to carry counts only ("已完成工具 N 个"). When
 * the engine session survives that is tolerable; when it was reset, the model
 * restarted from the bare request and redid or contradicted earlier work.
 * This block names what actually happened: files written/edited, commands
 * run, the model's own todo list with statuses, and the tail of its last
 * answer. Pure, bounded, derived from the turn's tool records only.
 */

const FILE_TOOLS = /^(write|edit|multiedit|apply_patch|patch|create_file|lily_write|lily_edit|notebookedit)$/i;
const SHELL_TOOLS = /^(bash|shell|shell_command|exec_command|run_command|execute)$/i;
const LIMITS = { files: 12, commands: 8, todos: 20, assistantChars: 600 };

function clip(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function toolName(tool) {
  return String(tool?.name || "").split(/[.:/]/).pop().toLowerCase();
}

function fileOf(input = {}) {
  return String(input.filePath || input.file_path || input.path || input.file || input.notebook_path || "").trim();
}

function todosFrom(state, tools) {
  const plan = Array.isArray(state?.taskRun?.plan) ? state.taskRun.plan : null;
  if (plan && plan.length) return plan.map((step) => ({ content: clip(step.title, 160), status: String(step.status || "pending") })).filter((t) => t.content);
  const lastTodo = tools.filter((tool) => toolName(tool) === "todowrite" && Array.isArray(tool.input?.todos)).pop();
  if (!lastTodo) return [];
  return lastTodo.input.todos
    .map((todo) => ({ content: clip(todo?.content || todo?.activeForm, 160), status: String(todo?.status || "pending") }))
    .filter((t) => t.content);
}

function summarizeWorkState(state = {}, options = {}) {
  const limits = { ...LIMITS, ...options };
  const tools = [...(state.tools?.values?.() || [])];
  const files = new Map();
  const commands = [];
  for (const tool of tools) {
    const name = toolName(tool);
    const input = tool?.input && typeof tool.input === "object" ? tool.input : {};
    const status = String(tool?.status || "running").toLowerCase();
    const ok = ["done", "completed", "success"].includes(status);
    if (FILE_TOOLS.test(name)) {
      const file = fileOf(input);
      if (file) files.set(file, { path: clip(file, 200), action: name === "write" || name === "create_file" ? "write" : "edit", ok });
    } else if (SHELL_TOOLS.test(name) && input.command) {
      commands.push({ command: clip(input.command, 120), ok });
    }
  }
  return {
    files: [...files.values()].slice(-limits.files),
    commands: commands.slice(-limits.commands),
    todos: todosFrom(state, tools).slice(0, limits.todos),
    lastAssistantText: clip(state.assistantText, limits.assistantChars),
  };
}

function hasWorkState(workState) {
  return Boolean(workState && (workState.files?.length || workState.commands?.length || workState.todos?.length || workState.lastAssistantText));
}

/** Prompt lines (Chinese, matching the parent-closure prompt) or []. */
function renderWorkState(workState) {
  if (!hasWorkState(workState)) return [];
  const mark = { completed: "[x]", in_progress: "[~]", cancelled: "[-]" };
  const lines = ["上一轮的实际工作状态（以此为准，不要重做已完成的部分）："];
  if (workState.files?.length) {
    lines.push("已改动文件：", ...workState.files.map((f) => `- ${f.path}（${f.action === "write" ? "写入" : "编辑"}${f.ok ? "" : "，结果未确认"}）`));
  }
  if (workState.commands?.length) {
    lines.push("已执行命令：", ...workState.commands.map((c) => `- ${c.command}${c.ok ? "" : "（结果未确认）"}`));
  }
  if (workState.todos?.length) {
    lines.push("待办清单：", ...workState.todos.map((t) => `${mark[t.status] || "[ ]"} ${t.content}`));
  }
  if (workState.lastAssistantText) lines.push(`上一轮最后的输出：${workState.lastAssistantText}`);
  return lines;
}

module.exports = { summarizeWorkState, renderWorkState, hasWorkState, LIMITS };
