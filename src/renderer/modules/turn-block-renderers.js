import { html, render } from "../../../node_modules/lit-html/lit-html.js";
import { renderMarkdownContent } from "./content-blocks.js";
import { t } from "../i18n/index.js";
import { revealLocalFileInFolder } from "./file-reveal.js";
import { showToast } from "./toast.js";
import { isEChartsBlock, renderEChartsBlock } from "./chart-renderer.js";
import { renderDataTableBlock } from "./data-table-renderer.js";
import { renderPdfBlock } from "./pdf-renderer.js";
import { renderHtmlBlock } from "./html-renderer.js";
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

function revealButton(block = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "assistant-reveal-btn";
  button.title = t("file.reveal");
  button.setAttribute("aria-label", t("file.reveal"));
  button.disabled = !block.path;
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6.75A2.75 2.75 0 0 1 5.75 4h4.47c.73 0 1.43.29 1.94.8l1.04 1.04c.23.23.54.36.86.36h4.19A2.75 2.75 0 0 1 21 8.95v8.3A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25V6.75Z"></path>
      <path d="M14.25 12.25h3.5v3.5"></path>
      <path d="m17.75 12.25-4.5 4.5"></path>
    </svg>
  `;
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
  const mediaClass = isImage ? "is-image" : isVideo ? "is-video" : isAudio ? "is-audio" : "is-file";
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

function renderCompactArtifact(block) {
  const name = artifactDisplayName(block, tr("artifact.untitled", "Artifact"));
  const size = bytesText(block.bytes);
  return el(html`
    <figure class="assistant-renderer-block assistant-renderer-artifact is-file is-compact">
      <figcaption>
        <code class="assistant-generated-file-path">${name}</code>
        ${size ? html`<span class="assistant-renderer-meta">${size}</span>` : ""}
        ${revealButton(block)}
      </figcaption>
    </figure>
  `);
}

function renderMarkdownArtifact(block) {
  const name = artifactDisplayName(block, tr("artifact.untitled", "Artifact"));
  const size = bytesText(block.bytes);
  const node = el(html`
    <section class="assistant-renderer-block assistant-renderer-markdown-artifact">
      <header class="assistant-renderer-artifact-header">
        <div class="assistant-renderer-artifact-title">
          <code class="assistant-generated-file-path">${name}</code>
          ${size ? html`<span class="assistant-renderer-meta">${size}</span>` : ""}
        </div>
        <div class="assistant-renderer-chart-actions">
          ${revealButton(block)}
        </div>
      </header>
      <div class="assistant-renderer-markdown-preview assistant-turn-final markdown-body">
        ${tr("renderer.markdownPreviewLoading", "Loading Markdown preview...")}
      </div>
    </section>
  `);
  const preview = node.querySelector(".assistant-renderer-markdown-preview");
  const key = `${block.path || ""}:${block.updatedAt || ""}:${block.bytes || ""}`;
  node.dataset.markdownPreviewKey = key;

  void (async () => {
    try {
      const result = await window.assistantClient?.readTextFile?.(block.path, { maxBytes: 1024 * 1024 });
      if (node.dataset.markdownPreviewKey !== key) return;
      if (!result?.ok) {
        preview.textContent = tr("renderer.markdownPreviewFailed", "Markdown preview is unavailable. Open the file to view it.");
        return;
      }
      const suffix = result.truncated
        ? `\n\n${tr("renderer.markdownPreviewTruncated", "Preview truncated. Open the file to view the full content.")}`
        : "";
      renderMarkdownContent(preview, `${result.text || ""}${suffix}`, { basePath: block.path || "" });
    } catch (error) {
      if (node.dataset.markdownPreviewKey !== key) return;
      preview.textContent = tr("renderer.markdownPreviewFailed", "Markdown preview is unavailable. Open the file to view it.");
      console.warn("[turn-block-renderers] markdown preview failed", error);
    }
  })();

  return node;
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
  ["markdown-artifact", renderMarkdownArtifact],
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
  const displayMode = type === "artifact" ? artifactDisplayMode(block) : "primary";
  if (displayMode === "compact") return RENDERERS.get("compact-artifact");
  if (type === "artifact" && artifactType === "pdf") return RENDERERS.get("pdf");
  if (type === "artifact" && artifactType === "html") return RENDERERS.get("html");
  if (type === "artifact" && artifactType === "markdown") return RENDERERS.get("markdown-artifact");
  return RENDERERS.get(type) || RENDERERS.get(artifactType);
}

function fallbackBlock(block) {
  const text = typeof block === "string" ? block : JSON.stringify(block, null, 2);
  return el(html`<pre class="assistant-renderer-block assistant-renderer-unknown">${text}</pre>`);
}

function renderBlockNode(block) {
  const renderer = rendererForBlock(block);
  const node = renderer ? renderer(block) : fallbackBlock(block);
  node.dataset.blockKey = turnResultBlockKey(block);
  return node;
}

export function renderResultBlocks(root, blocks = []) {
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
      next.push(renderBlockNode(normalized[i]));
    }
  }

  // Dispose nodes that are no longer present (and only those).
  for (const stale of prev.values()) disposeRendererTree(stale);

  root.replaceChildren(...next);
}
