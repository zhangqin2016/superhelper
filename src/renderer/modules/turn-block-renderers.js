import { html, render } from "../../../node_modules/lit-html/lit-html.js";
import { renderMarkdownContent } from "./content-blocks.js";
import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";
import { isEChartsBlock, renderEChartsBlock } from "./chart-renderer.js";
import { renderDataTableBlock } from "./data-table-renderer.js";
import { renderHtmlBlock } from "./html-renderer.js";
import { renderFileCard, revealButton } from "./preview-card.js";
import {
  artifactBlocksFromArtifacts,
  inferArtifactType,
  mergeTurnResultBlocks as mergeResultBlocks,
  turnResultBlockKey,
} from "./turn-artifact-model.js";
import {
  artifactDisplayName,
  artifactSourceUrl,
  bytesText,
} from "./turn-renderer-block-model.js";
import { renderCharacterResultCard } from "./character-result-card.js";

export {
  artifactBlocksFromArtifacts,
  mergeResultBlocks,
};

function tr(key, fallback, params) {
  const value = t(key, params);
  return value === key ? fallback : value;
}

// Render a one-shot lit-html template and return its root element. lit-html is
// the sanctioned templating foundation for block renderers — declarative,
// auto-escaping, standards-based, and self-contained (no bundler/import map).
function el(template) {
  const host = document.createElement("div");
  render(template, host);
  return host.firstElementChild || host;
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
  const code = block.code || block.text || block.diff || "";
  const caption = block.title || block.language || "";
  const node = el(html`
    <figure class="assistant-renderer-block assistant-renderer-code${block.type === "diff" ? " is-diff" : ""}">
      ${caption ? html`<figcaption>${caption}</figcaption>` : ""}
      <pre><code>${code}</code></pre>
    </figure>
  `);
  node.appendChild(copyButton(() => code));
  return node;
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
  return el(html`
    <div class="assistant-renderer-block assistant-renderer-chart assistant-renderer-json-fallback">
      <div class="assistant-renderer-label">${block.title || tr("renderer.chart", "Chart")}</div>
      <pre>${JSON.stringify(block.spec || block.data || block, null, 2)}</pre>
    </div>
  `);
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
  const isVideo = artifactType === "video";
  const isAudio = artifactType === "audio";
  const isMedia = isImage || isVideo || isAudio;
  const name = artifactDisplayName(block, tr("artifact.untitled", "Artifact"));
  const size = bytesText(block.bytes);
  const src = isMedia ? artifactSourceUrl(block) : "";
  const openViewer = async () => {
    const mod = await import("./image-viewer.js");
    mod.openImageViewer?.(src, name);
  };
  if (!isMedia) return renderFileCard(block);
  const mediaClass = isImage ? "is-image" : isVideo ? "is-video" : "is-audio";
  return el(html`
    <figure class="assistant-renderer-block assistant-renderer-artifact ${mediaClass}">
      ${isImage ? html`<img alt=${name} loading="lazy" src=${src} @click=${openViewer} />` : ""}
      ${isVideo ? html`<video aria-label=${name} controls preload="metadata" src=${src}></video>` : ""}
      ${isAudio ? html`<audio aria-label=${name} controls preload="metadata" src=${src}></audio>` : ""}
      <figcaption>
        <code class="assistant-generated-file-path">${name}</code>
        ${size ? html`<span class="assistant-renderer-meta">${size}</span>` : ""}
        ${revealButton(block)}
      </figcaption>
    </figure>
  `);
}

// Readable kinds open in the preview pane; the rest are revealed in their folder.
const PANE_KINDS = new Set(["html", "markdown", "pdf", "image"]);
function renderCompactArtifact(block) {
  const kind = inferArtifactType(block);
  return renderFileCard(block, PANE_KINDS.has(kind) ? kind : "");
}

/** Read a Markdown artifact and render it into `preview` (the preview pane). */
export async function loadMarkdownPreview(preview, block = {}) {
  const key = `${block.path || ""}:${block.updatedAt || ""}:${block.bytes || ""}`;
  preview.dataset.markdownPreviewKey = key;
  if (!preview.textContent.trim()) preview.textContent = tr("renderer.markdownPreviewLoading", "Loading Markdown preview...");
  try {
    const result = await window.assistantClient?.readTextFile?.(block.path, { maxBytes: 1024 * 1024 });
    if (preview.dataset.markdownPreviewKey !== key) return;
    if (!result?.ok) {
      preview.textContent = tr("renderer.markdownPreviewFailed", "Markdown preview is unavailable. Open the file to view it.");
      return;
    }
    const suffix = result.truncated
      ? `\n\n${tr("renderer.markdownPreviewTruncated", "Preview truncated. Open the file to view the full content.")}`
      : "";
    renderMarkdownContent(preview, `${result.text || ""}${suffix}`, { basePath: block.path || "" });
  } catch (error) {
    if (preview.dataset.markdownPreviewKey !== key) return;
    preview.textContent = tr("renderer.markdownPreviewFailed", "Markdown preview is unavailable. Open the file to view it.");
    console.warn("[turn-block-renderers] markdown preview failed", error);
  }
}

function sourceList(block = {}) {
  return String(block.source || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function artifactDisplayMode(block = {}) {
  const explicit = String(block.display || block.preview || "").toLowerCase();
  if (["hidden", "none"].includes(explicit)) return "hidden";
  if (["compact", "reference"].includes(explicit)) return "compact";
  if (["primary", "preview", "expanded"].includes(explicit)) return "primary";

  const sources = sourceList(block);
  if (!sources.length || sources.includes("content_block")) return "primary";
  if (sources.includes("file_change") || sources.includes("tool_write")) return "primary";
  return "compact";
}

function renderForm(block) {
  const fields = Array.isArray(block.fields) ? block.fields : [];
  return el(html`
    <section class="assistant-renderer-block assistant-renderer-form">
      <h4>${block.title || tr("renderer.form", "Form")}</h4>
      ${fields.map(
        (field) => html`
          <div class="assistant-renderer-form-row">
            <span>${field.label || field.name || ""}</span>
            <strong>${field.value == null ? "" : String(field.value)}</strong>
          </div>
        `,
      )}
      ${block.description ? html`<p>${block.description}</p>` : ""}
    </section>
  `);
}

function renderActionResult(block) {
  return el(html`
    <section class="assistant-renderer-block assistant-renderer-action-result is-${block.status || "info"}">
      <h4>${block.title || tr("renderer.actionResult", "Result")}</h4>
      ${block.message ? html`<p>${block.message}</p>` : ""}
    </section>
  `);
}

const RENDERERS = new Map([
  ["markdown", renderMarkdown],
  ["text", renderMarkdown],
  ["code", renderCode],
  ["diff", renderCode],
  ["table", renderTable],
  ["chart", renderChart],
  ["artifact", renderArtifact],
  ["compact-artifact", renderCompactArtifact],
  ["image", renderArtifact],
  ["file", renderArtifact],
  ["markdown-artifact", (block) => renderFileCard(block, "markdown")],
  ["pdf", (block) => renderFileCard(block, "pdf")],
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
  // HTML, Markdown and PDF are read in the preview pane: always a card here,
  // which a mere reference and a delivered file share (both can be opened).
  if (type === "artifact" && artifactType === "html") return RENDERERS.get("html");
  if (type === "artifact" && artifactType === "markdown") return RENDERERS.get("markdown-artifact");
  if (type === "artifact" && artifactType === "pdf") return RENDERERS.get("pdf");
  const displayMode = type === "artifact" ? artifactDisplayMode(block) : "primary";
  if (displayMode === "compact") return RENDERERS.get("compact-artifact");
  return RENDERERS.get(type) || RENDERERS.get(artifactType);
}

function fallbackBlock(block) {
  const text = typeof block === "string" ? block : JSON.stringify(block, null, 2);
  return el(html`<pre class="assistant-renderer-block assistant-renderer-unknown">${text}</pre>`);
}

function renderBlockNode(block, options = {}) {
  if (block?.type === "character_worlds_receipt") {
    const node = renderCharacterResultCard(block, options);
    node.dataset.blockKey = turnResultBlockKey(block);
    return node;
  }
  const renderer = rendererForBlock(block);
  const node = renderer ? renderer(block) : fallbackBlock(block);
  node.dataset.blockKey = turnResultBlockKey(block);
  return node;
}

export function renderResultBlocks(root, blocks = [], options = {}) {
  if (!root) return;
  const normalized = Array.isArray(blocks)
    ? blocks.filter((block) => block?.type && (
      String(block.type || "").toLowerCase() !== "artifact" || artifactDisplayMode(block) !== "hidden"
    ))
    : [];
  const keys = normalized.map(turnResultBlockKey);
  const listKey = keys.join("|");
  if (root.dataset.resultBlockKey === listKey) return;
  root.dataset.resultBlockKey = listKey;
  root.hidden = normalized.length === 0;

  // Keyed reconciliation: reuse the existing DOM node for any block whose key
  // is unchanged (preserves live ECharts/PDF instances + scroll state), render
  // only new blocks, and dispose only the ones that actually went away.
  const prev = new Map();
  for (const node of Array.from(root.children)) {
    const k = node.dataset?.blockKey;
    if (k && !prev.has(k)) prev.set(k, node);
  }

  const next = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const k = keys[i];
    const reused = prev.get(k);
    if (reused) {
      prev.delete(k);
      next.push(reused);
    } else {
      next.push(renderBlockNode(normalized[i], options));
    }
  }

  // Dispose nodes that are no longer present (and only those).
  for (const stale of prev.values()) disposeRendererTree(stale);

  root.replaceChildren(...next);
}
