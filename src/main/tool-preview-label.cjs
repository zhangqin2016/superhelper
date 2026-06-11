"use strict";

/**
 * Keep in sync with src/renderer/modules/tool-preview-label.js
 */

const PREVIEW_MAX = 160;

function looksLikeJsonPreview(text) {
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

// Locale-aware media labels (the renderer mirror uses the i18n table; this
// main-process copy reads the app locale directly).
const MEDIA_PREVIEW_LABELS = {
  image: { "zh-CN": "生成图片", en: "Generate image", ar: "إنشاء صورة" },
  video: { "zh-CN": "生成视频", en: "Generate video", ar: "إنشاء فيديو" },
  speech: { "zh-CN": "生成语音", en: "Generate speech", ar: "إنشاء صوت" },
};

function mediaLabel(kind) {
  let locale = "en";
  try {
    locale = require("./locale-settings").getLocale() || "en";
  } catch {
    // settings unavailable (tests): default English
  }
  const table = MEDIA_PREVIEW_LABELS[kind] || {};
  return table[locale] || table.en || "";
}

function mediaGenerationPreview(command = "") {
  const value = String(command || "");
  if (!value) return "";
  if (value.includes("lily-image-generation") || value.includes("generate-image.cjs")) {
    return mediaLabel("image");
  }
  if (value.includes("lily-video-generation") || value.includes("generate-video.cjs")) {
    return mediaLabel("video");
  }
  if (value.includes("lily-speech-generation") || value.includes("generate-speech.cjs")) {
    return mediaLabel("speech");
  }
  return "";
}

function buildToolPreviewLabel(tool = {}) {
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

module.exports = {
  buildToolPreviewLabel,
  looksLikeJsonPreview,
  mediaGenerationPreview,
};
