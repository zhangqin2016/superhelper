/**
 * Structured rendering for tool input/result JSON — not raw stringify dumps.
 */

import { renderMarkdown } from "./markdown.js";
import { t } from "../i18n/index.js";

const FILE_PATH_KEYS = ["file_path", "path", "target_file"];
const LONG_TEXT_KEYS = new Set([
  "content",
  "text",
  "body",
  "message",
  "old_string",
  "new_string",
  "command",
  "instructions",
  "prompt",
  "code",
  "input",
  "output",
  "stdout",
  "stderr",
  "result",
  "description",
]);
const MARKDOWN_KEYS = new Set(["content", "text", "body", "message", "instructions", "prompt"]);
const GENERATED_MEDIA_TEXT_KEYS = ["content", "stdout", "output", "result", "text", "message"];

export function parseToolInput(tool = {}) {
  if (tool.input && Object.keys(tool.input).length) {
    const copy = { ...tool.input };
    delete copy.preview;
    return copy;
  }
  if (!tool.partialJson) return null;
  try {
    const parsed = JSON.parse(tool.partialJson);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { __partialJson: tool.partialJson };
  }
}

export function parseToolResult(result) {
  if (result == null) return null;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { content: result };
    }
    return { content: result };
  }
  if (typeof result.content === "string") {
    try {
      const parsed = JSON.parse(result.content);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { content: result.content, truncated: result.truncated, fullText: result.fullText };
    }
  }
  return result;
}

function decodeXmlAttribute(value = "") {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(raw = "") {
  const attrs = {};
  const pattern = /([a-zA-Z_:-][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(String(raw)))) {
    attrs[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attrs;
}

export function parseGeneratedMedia(text = "") {
  const source = String(text || "");
  if (!source.includes("<generated_media")) return [];
  const blocks = [];
  const blockPattern = /<generated_media\b([^>]*)>([\s\S]*?)<\/generated_media>/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(source))) {
    const attrs = parseAttributes(blockMatch[1]);
    const body = blockMatch[2] || "";
    const taskId = decodeXmlAttribute((body.match(/<task_id>([\s\S]*?)<\/task_id>/) || [])[1] || "").trim();
    const files = [];
    const filePattern = /<file\b([^>]*)\/>/g;
    let fileMatch;
    while ((fileMatch = filePattern.exec(body))) {
      const file = parseAttributes(fileMatch[1]);
      if (!file.path) continue;
      files.push({
        path: file.path,
        bytes: Number(file.bytes || 0) || 0,
        mimeType: file.mimeType || file.mime_type || "",
      });
    }
    if (files.length) {
      blocks.push({
        type: attrs.type || "file",
        taskId,
        files,
      });
    }
  }
  return blocks;
}

function generatedMediaFromPayload(payload) {
  if (!payload) return [];
  if (typeof payload === "string") return parseGeneratedMedia(payload);
  if (typeof payload !== "object") return [];
  const out = [];
  for (const key of GENERATED_MEDIA_TEXT_KEYS) {
    if (typeof payload[key] === "string") out.push(...parseGeneratedMedia(payload[key]));
  }
  return out;
}

function fileUrlFromPath(filePath = "") {
  const value = String(filePath || "").trim();
  if (!value) return "";
  if (/^(?:https?|file|blob|data):/i.test(value)) return value;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return encodeURI(`file:///${value.replace(/\\/g, "/")}`);
  if (value.startsWith("/")) return encodeURI(`file://${value}`);
  return value;
}

function mediaTitle(type) {
  if (type === "video") return t("tool.media.video");
  if (type === "audio" || type === "speech") return t("tool.media.audio");
  if (type === "image") return t("tool.media.image");
  return t("tool.media.file");
}

function mediaAlt(type, index) {
  if (type === "video") return t("tool.media.videoAlt", { index });
  if (type === "audio" || type === "speech") return t("tool.media.audioAlt", { index });
  if (type === "image") return t("tool.media.imageAlt", { index });
  return t("tool.media.fileAlt", { index });
}

function toolKind(name = "") {
  const n = String(name).toLowerCase();
  if (n === "write") return "write";
  if (n === "edit" || n === "notebookedit") return "edit";
  if (n === "multiedit") return "multiedit";
  if (n === "read") return "read";
  if (n === "bash") return "bash";
  if (n === "grep" || n === "glob") return "search";
  return "generic";
}

function firstFilePath(obj = {}) {
  for (const key of FILE_PATH_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isLongText(value) {
  if (typeof value !== "string") return false;
  return value.length > 120 || value.includes("\n");
}

function fieldLabel(key) {
  const map = {
    file_path: "tool.field.filePath",
    path: "tool.field.filePath",
    target_file: "tool.field.filePath",
    content: "tool.field.content",
    old_string: "tool.field.oldString",
    new_string: "tool.field.newString",
    command: "tool.field.command",
    pattern: "tool.field.pattern",
    query: "tool.field.query",
    url: "tool.field.url",
    offset: "tool.field.offset",
    limit: "tool.field.limit",
    edits: "tool.field.edits",
  };
  return t(map[key] || "tool.field.generic", { key });
}

function createPayloadRoot(className = "") {
  const root = document.createElement("div");
  root.className = `assistant-tool-payload${className ? ` ${className}` : ""}`;
  return root;
}

function appendFilePathRow(root, filePath) {
  if (!filePath) return;
  const row = document.createElement("div");
  row.className = "assistant-tool-field assistant-tool-field-path";
  const label = document.createElement("span");
  label.className = "assistant-tool-field-label";
  label.textContent = fieldLabel("file_path");
  const value = document.createElement("code");
  value.className = "assistant-tool-file-path";
  value.textContent = filePath;
  row.append(label, value);
  root.appendChild(row);
}

function appendTextBlock(root, key, text, { markdown = false } = {}) {
  if (text == null || text === "") return;
  const block = document.createElement("div");
  block.className = "assistant-tool-field assistant-tool-field-text";
  const label = document.createElement("div");
  label.className = "assistant-tool-field-label";
  label.textContent = fieldLabel(key);
  block.appendChild(label);

  if (markdown) {
    const body = document.createElement("div");
    body.className = "assistant-tool-content markdown-body";
    body.textContent = String(text);
    void renderMarkdown(body, String(text));
    block.appendChild(body);
  } else {
    const pre = document.createElement("pre");
    pre.className = "assistant-tool-detail assistant-tool-field-value";
    pre.textContent = String(text);
    block.appendChild(pre);
  }
  root.appendChild(block);
}

function appendScalarRow(root, key, value) {
  const row = document.createElement("div");
  row.className = "assistant-tool-field assistant-tool-field-scalar";
  const label = document.createElement("span");
  label.className = "assistant-tool-field-label";
  label.textContent = fieldLabel(key);
  const val = document.createElement("span");
  val.className = "assistant-tool-field-value";
  val.textContent = formatScalar(value);
  row.append(label, val);
  root.appendChild(row);
}

function formatScalar(value) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function appendEditsList(root, edits = []) {
  if (!Array.isArray(edits) || !edits.length) return;
  const wrap = document.createElement("div");
  wrap.className = "assistant-tool-edits";
  const title = document.createElement("div");
  title.className = "assistant-tool-field-label";
  title.textContent = fieldLabel("edits");
  wrap.appendChild(title);

  edits.forEach((edit, index) => {
    const item = document.createElement("details");
    item.className = "assistant-tool-edit-item";
    const summary = document.createElement("summary");
    summary.textContent = t("tool.field.editItem", { index: index + 1 });
    item.appendChild(summary);
    const body = createPayloadRoot("assistant-tool-edit-body");
    if (edit?.old_string != null) appendTextBlock(body, "old_string", edit.old_string);
    if (edit?.new_string != null) appendTextBlock(body, "new_string", edit.new_string);
    renderGenericObject(body, edit, { skip: new Set(["old_string", "new_string"]) });
    item.appendChild(body);
    wrap.appendChild(item);
  });
  root.appendChild(wrap);
}

function renderGenericObject(root, obj, { skip = new Set() } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.__partialJson) {
    const pre = document.createElement("pre");
    pre.className = "assistant-tool-detail assistant-tool-partial-json";
    pre.textContent = obj.__partialJson;
    root.appendChild(pre);
    return true;
  }

  let rendered = false;
  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key) || key === "preview") continue;
    rendered = true;
    if (value == null) continue;

    if (typeof value === "string" && parseGeneratedMedia(value).length) {
      continue;
    }

    if (typeof value === "string" && isLongText(value)) {
      appendTextBlock(root, key, value, { markdown: MARKDOWN_KEYS.has(key) });
      continue;
    }

    if (Array.isArray(value)) {
      if (key === "edits") {
        appendEditsList(root, value);
        continue;
      }
      const list = document.createElement("div");
      list.className = "assistant-tool-field assistant-tool-field-list";
      const label = document.createElement("div");
      label.className = "assistant-tool-field-label";
      label.textContent = fieldLabel(key);
      list.appendChild(label);
      const pre = document.createElement("pre");
      pre.className = "assistant-tool-detail assistant-tool-field-value";
      pre.textContent = JSON.stringify(value, null, 2);
      list.appendChild(pre);
      root.appendChild(list);
      continue;
    }

    if (typeof value === "object") {
      const nested = createPayloadRoot("assistant-tool-nested");
      const head = document.createElement("div");
      head.className = "assistant-tool-field-label";
      head.textContent = fieldLabel(key);
      nested.appendChild(head);
      renderGenericObject(nested, value);
      root.appendChild(nested);
      continue;
    }

    appendScalarRow(root, key, value);
  }
  return rendered;
}

function renderGeneratedMedia(root, mediaBlocks = []) {
  if (!mediaBlocks.length) return false;
  for (const media of mediaBlocks) {
    const wrap = document.createElement("div");
    wrap.className = `assistant-generated-media is-${media.type || "file"}`;

    const head = document.createElement("div");
    head.className = "assistant-generated-media-head";
    const title = document.createElement("span");
    title.textContent = mediaTitle(media.type);
    head.appendChild(title);
    if (media.taskId) {
      const task = document.createElement("code");
      task.textContent = media.taskId;
      head.appendChild(task);
    }
    wrap.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "assistant-generated-media-grid";
    media.files.forEach((file, index) => {
      const item = document.createElement("figure");
      item.className = "assistant-generated-media-item";
      const src = fileUrlFromPath(file.path);
      const type = media.type || "file";
      if (type === "image") {
        const img = document.createElement("img");
        img.src = src;
        img.alt = mediaAlt(type, index + 1);
        img.loading = "lazy";
        img.addEventListener("click", async () => {
          const mod = await import("./image-viewer.js");
          mod.openImageViewer?.(src, img.alt);
        });
        item.appendChild(img);
      } else if (type === "video") {
        const video = document.createElement("video");
        video.src = src;
        video.controls = true;
        video.preload = "metadata";
        item.appendChild(video);
      } else if (type === "audio" || type === "speech") {
        const audio = document.createElement("audio");
        audio.src = src;
        audio.controls = true;
        item.appendChild(audio);
      }

      const caption = document.createElement("figcaption");
      const label = document.createElement("span");
      label.textContent = t("tool.media.savedTo");
      const pathCode = document.createElement("code");
      pathCode.textContent = file.path;
      // A bare path is hard to act on — clicking it (or the reveal button)
      // shows the file in the system file manager.
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "assistant-reveal-btn";
      reveal.textContent = t("file.reveal");
      const doReveal = () => void window.assistantClient.revealInFolder(file.path);
      reveal.addEventListener("click", doReveal);
      pathCode.classList.add("is-clickable");
      pathCode.title = t("file.reveal");
      pathCode.addEventListener("click", doReveal);
      caption.append(label, pathCode, reveal);
      item.appendChild(caption);
      grid.appendChild(item);
    });
    wrap.appendChild(grid);
    root.appendChild(wrap);
  }
  return true;
}

function renderWritePayload(root, payload, { compact = false } = {}) {
  const filePath = firstFilePath(payload);
  appendFilePathRow(root, filePath);
  if (payload.content != null) {
    if (compact) {
      const lines = String(payload.content).split("\n").length;
      appendScalarRow(root, "content", t("tool.field.lineCount", { count: lines }));
    } else {
      appendTextBlock(root, "content", payload.content, { markdown: true });
    }
  }
  renderGenericObject(root, payload, { skip: new Set([...FILE_PATH_KEYS, "content"]) });
}

function renderEditPayload(root, payload) {
  appendFilePathRow(root, firstFilePath(payload));
  if (payload.old_string != null) appendTextBlock(root, "old_string", payload.old_string);
  if (payload.new_string != null) appendTextBlock(root, "new_string", payload.new_string);
  renderGenericObject(root, payload, {
    skip: new Set([...FILE_PATH_KEYS, "old_string", "new_string", "edits"]),
  });
}

function renderMultiEditPayload(root, payload) {
  appendFilePathRow(root, firstFilePath(payload));
  appendEditsList(root, payload.edits);
  renderGenericObject(root, payload, {
    skip: new Set([...FILE_PATH_KEYS, "edits", "old_string", "new_string"]),
  });
}

function renderReadPayload(root, payload) {
  appendFilePathRow(root, firstFilePath(payload));
  renderGenericObject(root, payload, { skip: new Set(FILE_PATH_KEYS) });
}

function renderBashPayload(root, payload) {
  if (payload.command != null) appendTextBlock(root, "command", payload.command);
  renderGenericObject(root, payload, { skip: new Set(["command"]) });
}

function renderSearchPayload(root, payload) {
  renderGenericObject(root, payload);
}

function renderStructuredPayload(root, tool, payload, options = {}) {
  if (!payload) return false;
  if (options.role === "result") {
    renderGeneratedMedia(root, generatedMediaFromPayload(payload));
  }
  const kind = toolKind(tool.name);
  if (kind === "write") renderWritePayload(root, payload, options);
  else if (kind === "edit") renderEditPayload(root, payload);
  else if (kind === "multiedit") renderMultiEditPayload(root, payload);
  else if (kind === "read") renderReadPayload(root, payload);
  else if (kind === "bash") renderBashPayload(root, payload);
  else if (kind === "search") renderSearchPayload(root, payload);
  else renderGenericObject(root, payload);
  return root.childElementCount > 0;
}

/**
 * Append structured tool input/result into a tool row. Returns true if rendered.
 */
export function appendToolPayloadDetail(container, tool, { role = "input", compactFileContent = false } = {}) {
  if (!container) return false;

  const payload = role === "result" ? parseToolResult(tool.result) : parseToolInput(tool);
  if (!payload) return false;

  const root = createPayloadRoot(role === "result" ? "is-result" : "is-input");
  const ok = renderStructuredPayload(root, tool, payload, { compact: compactFileContent, role });
  if (!ok) return false;
  container.appendChild(root);
  return true;
}

export function toolInputHasRenderableDetail(tool = {}) {
  return Boolean(parseToolInput(tool));
}
