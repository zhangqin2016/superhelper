import { renderMarkdownContent } from "./content-blocks.js";
import { t } from "../i18n/index.js";
import { revealLocalFileInFolder } from "./file-reveal.js";
import { showToast } from "./toast.js";
import { isEChartsBlock, renderEChartsBlock } from "./chart-renderer.js";
import { renderDataTableBlock } from "./data-table-renderer.js";
import { renderPdfBlock } from "./pdf-renderer.js";
import { renderHtmlBlock } from "./html-renderer.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function tr(key, fallback, params) {
  const value = t(key, params);
  return value === key ? fallback : value;
}

function fileUrlFromPath(filePath = "") {
  const value = String(filePath || "");
  if (/^(https?:|file:|blob:|data:)/i.test(value)) return value;
  if (/^[A-Za-z]:[\\/]/.test(value)) return `file:///${value.replace(/\\/g, "/")}`;
  if (value.startsWith("/")) return `file://${value}`;
  return value;
}

function dataUrl(block = {}) {
  if (!block.data) return "";
  return `data:${block.mimeType || "image/png"};base64,${block.data}`;
}

function normalizeExtension(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith(".") ? text : `.${text}`;
}

function extensionFromPath(filePath = "") {
  const match = String(filePath || "").match(/\.[^./\\]+$/);
  return normalizeExtension(match?.[0] || "");
}

function inferArtifactType(block = {}) {
  const declared = String(block.artifactType || block.type || "").toLowerCase();
  if (["image", "pdf", "html", "chart", "video", "audio"].includes(declared)) return declared;
  const mime = String(block.mimeType || "").toLowerCase();
  const ext = normalizeExtension(block.ext || extensionFromPath(block.path || block.relativePath || block.fileName));
  if (block.kind === "image" || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime === "text/html" || ext === ".html" || ext === ".htm") return "html";
  return "file";
}

function bytesText(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function displayName(block = {}) {
  return block.title || block.relativePath || block.fileName || block.path || block.alt ||
    tr("artifact.untitled", "Artifact");
}

function revealButton(block = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "assistant-renderer-action";
  button.textContent = t("file.reveal");
  button.disabled = !block.path;
  button.addEventListener("click", () => {
    if (block.path) void revealLocalFileInFolder(block.path);
  });
  return button;
}

function copyButton(textProvider) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "assistant-renderer-action";
  button.textContent = t("common.copy");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(String(textProvider?.() || ""));
      showToast(t("common.copied"), "success");
    } catch {
      showToast(t("common.copyFailed"), "warning");
    }
  });
  return button;
}

function renderMarkdown(block) {
  const node = document.createElement("div");
  node.className = "assistant-renderer-block assistant-renderer-markdown markdown-body";
  renderMarkdownContent(node, block.text || block.content || "");
  return node;
}

function renderCode(block) {
  const wrap = document.createElement("figure");
  wrap.className = `assistant-renderer-block assistant-renderer-code${block.type === "diff" ? " is-diff" : ""}`;
  if (block.title || block.language) {
    const caption = document.createElement("figcaption");
    caption.textContent = block.title || block.language || "";
    wrap.appendChild(caption);
  }
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = block.code || block.text || block.diff || "";
  pre.appendChild(code);
  wrap.appendChild(pre);
  wrap.appendChild(copyButton(() => code.textContent));
  return wrap;
}

function renderTable(block) {
  return renderDataTableBlock(block);
}

function renderMermaidChart(block) {
  const node = document.createElement("div");
  node.className = "assistant-renderer-block assistant-renderer-chart markdown-body";
  const source = String(block.source || block.code || "").trim();
  renderMarkdownContent(node, source ? `\`\`\`mermaid\n${source}\n\`\`\`` : "");
  return node;
}

function renderChart(block) {
  if ((block.chartType || "").toLowerCase() === "mermaid") return renderMermaidChart(block);
  if (isEChartsBlock(block)) return renderEChartsBlock(block);
  const node = document.createElement("div");
  node.className = "assistant-renderer-block assistant-renderer-chart assistant-renderer-json-fallback";
  const title = document.createElement("div");
  title.className = "assistant-renderer-label";
  title.textContent = block.title || tr("renderer.chart", "Chart");
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(block.spec || block.data || block, null, 2);
  node.append(title, pre);
  return node;
}

function disposeRendererTree(root) {
  if (!root?.querySelectorAll) return;
  const nodes = [
    ...(typeof root.__disposeRenderer === "function" ? [root] : []),
    ...root.querySelectorAll("*"),
  ];
  for (const node of nodes) {
    if (typeof node.__disposeRenderer !== "function") continue;
    try {
      node.__disposeRenderer();
    } catch (error) {
      console.warn("[turn-block-renderers] renderer dispose failed", error);
    }
    delete node.__disposeRenderer;
  }
}

function renderArtifact(block) {
  const artifactType = inferArtifactType(block);
  const isImage = artifactType === "image";
  const figure = document.createElement("figure");
  figure.className = `assistant-renderer-block assistant-renderer-artifact${isImage ? " is-image" : " is-file"}`;
  if (isImage) {
    const img = document.createElement("img");
    img.alt = displayName(block);
    img.loading = "lazy";
    img.src = dataUrl(block) || fileUrlFromPath(block.path || "");
    img.addEventListener("click", async () => {
      const mod = await import("./image-viewer.js");
      mod.openImageViewer?.(img.src, img.alt);
    });
    figure.appendChild(img);
  }
  const caption = document.createElement("figcaption");
  const name = document.createElement("code");
  name.className = "assistant-generated-file-path";
  name.textContent = displayName(block);
  const size = bytesText(block.bytes);
  caption.appendChild(name);
  if (size) {
    const meta = document.createElement("span");
    meta.className = "assistant-renderer-meta";
    meta.textContent = size;
    caption.appendChild(meta);
  }
  caption.appendChild(revealButton(block));
  figure.appendChild(caption);
  return figure;
}

function renderForm(block) {
  const card = document.createElement("section");
  card.className = "assistant-renderer-block assistant-renderer-form";
  const title = document.createElement("h4");
  title.textContent = block.title || tr("renderer.form", "Form");
  card.appendChild(title);
  const fields = Array.isArray(block.fields) ? block.fields : [];
  for (const field of fields) {
    const row = document.createElement("div");
    row.className = "assistant-renderer-form-row";
    const label = document.createElement("span");
    label.textContent = field.label || field.name || "";
    const value = document.createElement("strong");
    value.textContent = field.value == null ? "" : String(field.value);
    row.append(label, value);
    card.appendChild(row);
  }
  if (block.description) {
    const desc = document.createElement("p");
    desc.textContent = block.description;
    card.appendChild(desc);
  }
  return card;
}

function renderActionResult(block) {
  const card = document.createElement("section");
  card.className = `assistant-renderer-block assistant-renderer-action-result is-${block.status || "info"}`;
  const title = document.createElement("h4");
  title.textContent = block.title || tr("renderer.actionResult", "Result");
  card.appendChild(title);
  if (block.message) {
    const body = document.createElement("p");
    body.textContent = block.message;
    card.appendChild(body);
  }
  return card;
}

const RENDERERS = new Map([
  ["markdown", renderMarkdown],
  ["text", renderMarkdown],
  ["code", renderCode],
  ["diff", renderCode],
  ["table", renderTable],
  ["chart", renderChart],
  ["artifact", renderArtifact],
  ["image", renderArtifact],
  ["file", renderArtifact],
  ["pdf", renderPdfBlock],
  ["html", renderHtmlBlock],
  ["video", renderArtifact],
  ["audio", renderArtifact],
  ["form", renderForm],
  ["action_result", renderActionResult],
  ["action-result", renderActionResult],
]);

function rendererForBlock(block = {}) {
  const type = String(block.type || "").toLowerCase();
  const artifactType = type === "artifact" ? inferArtifactType(block) : String(block.artifactType || "").toLowerCase();
  if (type === "artifact" && artifactType === "chart") return RENDERERS.get("chart");
  if (type === "artifact" && artifactType === "pdf") return RENDERERS.get("pdf");
  if (type === "artifact" && artifactType === "html") return RENDERERS.get("html");
  return RENDERERS.get(type) || RENDERERS.get(artifactType);
}

function blockKey(block = {}) {
  return [
    block.id || "",
    block.type || "",
    block.artifactType || "",
    block.path || "",
    block.updatedAt || "",
    block.bytes || "",
    block.text || block.source || block.code || "",
  ].join(":");
}

function fallbackBlock(block) {
  const node = document.createElement("pre");
  node.className = "assistant-renderer-block assistant-renderer-unknown";
  node.textContent = typeof block === "string" ? block : JSON.stringify(block, null, 2);
  return node;
}

export function renderResultBlocks(root, blocks = []) {
  if (!root) return;
  const normalized = Array.isArray(blocks) ? blocks.filter((block) => block?.type) : [];
  const key = normalized.map(blockKey).join("|");
  if (root.dataset.resultBlockKey === key) return;
  root.dataset.resultBlockKey = key;
  disposeRendererTree(root);
  root.replaceChildren();
  root.hidden = normalized.length === 0;
  for (const block of normalized) {
    const renderer = rendererForBlock(block);
    root.appendChild(renderer ? renderer(block) : fallbackBlock(block));
  }
}

export function artifactBlocksFromArtifacts(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => artifact?.path)
    .map((artifact) => ({
      id: `artifact:${artifact.id || artifact.path}`,
      type: "artifact",
      artifactType: inferArtifactType(artifact),
      path: artifact.path,
      relativePath: artifact.relativePath || artifact.fileName || artifact.path,
      fileName: artifact.fileName || "",
      ext: artifact.ext || extensionFromPath(artifact.path || artifact.relativePath || artifact.fileName),
      mimeType: artifact.mimeType || "",
      bytes: artifact.bytes || 0,
      updatedAt: artifact.updatedAt || 0,
      source: artifact.source || "",
    }));
}

export function mergeResultBlocks(resultBlocks = [], artifacts = []) {
  const seen = new Set();
  const out = [];
  for (const block of [...(resultBlocks || []), ...artifactBlocksFromArtifacts(artifacts)]) {
    if (!block?.type) continue;
    const key = block.path
      ? `${block.type}:${block.artifactType || ""}:${block.path}`
      : `${block.type}:${block.artifactType || ""}:${block.id || block.data || blockKey(block)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}
