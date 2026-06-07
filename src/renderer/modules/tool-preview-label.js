/**
 * Human-readable one-line labels for tool timeline rows (never raw JSON dumps).
 */

const PREVIEW_MAX = 160;

export function looksLikeJsonPreview(text) {
  const value = String(text || "").trim();
  if (!value || !(value.startsWith("{") || value.startsWith("["))) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function truncate(text, max = PREVIEW_MAX) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function todoSummary(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return "";
  const first = todos[0];
  let label = "";
  if (typeof first === "string") label = first;
  else if (first && typeof first === "object") {
    label = first.content || first.subject || first.title || first.description || first.activeForm || "";
  }
  if (!label) return `Todos (${todos.length})`;
  const base = truncate(label);
  return todos.length > 1 ? `${base} (+${todos.length - 1})` : base;
}

function statusTick(input) {
  if (input.taskId == null && input.id == null) return "";
  const id = input.taskId ?? input.id;
  const status = input.status ?? input.state;
  if (status == null || status === "") return `#${id}`;
  return `#${id} · ${status}`;
}

function pickText(input) {
  for (const key of ["subject", "description", "prompt", "instructions", "query", "title", "message", "activeForm"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncate(value);
  }
  return "";
}

export function mediaGenerationPreview(command = "") {
  const value = String(command || "");
  if (!value) return "";
  if (value.includes("lily-image-generation") || value.includes("generate-image.cjs")) {
    return "生成图片";
  }
  if (value.includes("lily-video-generation") || value.includes("generate-video.cjs")) {
    return "生成视频";
  }
  if (value.includes("lily-speech-generation") || value.includes("generate-speech.cjs")) {
    return "生成语音";
  }
  return "";
}

export function buildToolPreviewLabel(tool = {}) {
  const input = tool.input || {};
  const name = tool.name || "Tool";
  const lowerName = String(name).toLowerCase();

  if (lowerName === "bash" && input.command) {
    const mediaPreview = mediaGenerationPreview(input.command);
    if (mediaPreview) return mediaPreview;
    return truncate(`Bash ${input.command}`, 260);
  }
  if ((lowerName === "glob" || lowerName === "grep") && input.pattern) {
    return truncate(`${name} ${input.pattern}`, 260);
  }
  if (lowerName === "read" && (input.file_path || input.path)) {
    return truncate(`Read ${input.file_path || input.path}`, 260);
  }
  if ((lowerName === "write" || lowerName === "edit" || lowerName === "multiedit" || lowerName === "notebookedit") &&
    (input.file_path || input.path || input.target_file)) {
    const path = input.file_path || input.path || input.target_file;
    const verb = lowerName === "write" ? "Write"
      : lowerName === "multiedit" ? "MultiEdit"
        : lowerName === "notebookedit" ? "NotebookEdit"
          : "Edit";
    return truncate(`${verb} ${path}`, 260);
  }

  const cached = input.preview;
  if (typeof cached === "string" && cached.trim() && !looksLikeJsonPreview(cached)) {
    return truncate(cached, 260);
  }

  const text = pickText(input);
  if (text) return text;

  if (Array.isArray(input.todos)) {
    const summary = todoSummary(input.todos);
    if (summary) return summary;
  }

  const tick = statusTick(input);
  if (tick) return tick;

  const command = String(input.command || input.cmd || input.script || "").trim();
  if (command) {
    const mediaPreview = mediaGenerationPreview(command);
    if (mediaPreview) return mediaPreview;
    return truncate(`Bash ${command}`, 260);
  }

  const filePath = String(input.file_path || input.path || input.target_file || "").trim();
  if (filePath) return truncate(`${name} ${filePath}`, 260);

  return truncate(name, 80);
}
