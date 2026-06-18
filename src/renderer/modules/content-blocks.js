import { renderMarkdownWithCache, renderStreamingMarkdown } from "./markdown.js";
import { isMermaidLanguage, looksLikeMermaidCode, normalizeCodeLanguage } from "./mermaid-detect.js";

function stripCodeIndent(lines = []) {
  return lines
    .map((line) => line.startsWith("\t") ? line.slice(1) : line.replace(/^ {4}/, ""))
    .join("\n")
    .trimEnd();
}

function pushMarkdown(blocks, lines) {
  const text = lines.join("\n");
  if (!text.trim()) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === "markdown") {
    last.text = `${last.text}\n${text}`;
    return;
  }
  blocks.push({ type: "markdown", text });
}

function pushChart(blocks, source, meta = {}) {
  const trimmed = String(source || "").trim();
  if (!trimmed) return;
  blocks.push({
    type: "artifact",
    artifactType: "chart",
    chartType: "mermaid",
    source: trimmed,
    sourceFormat: meta.sourceFormat || "mermaid",
  });
}

/**
 * Converts loose model markdown into stable render blocks.
 *
 * This is intentionally conservative: normal markdown stays markdown, while
 * known structured artifacts become explicit blocks so history replay does not
 * depend on guessing inside UI components.
 */
export function markdownToContentBlocks(markdownText = "") {
  const text = String(markdownText || "");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const blocks = [];
  const pending = [];

  const flushPending = () => {
    pushMarkdown(blocks, pending.splice(0, pending.length));
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^```([^\s`]*)?.*$/);
    if (fence) {
      const fencedLines = [line];
      const codeLines = [];
      i += 1;
      for (; i < lines.length; i += 1) {
        fencedLines.push(lines[i]);
        if (/^```\s*$/.test(lines[i])) break;
        codeLines.push(lines[i]);
      }
      const lang = normalizeCodeLanguage(fence[1] || "");
      const source = codeLines.join("\n").trimEnd();
      if (isMermaidLanguage(lang) || (!lang && looksLikeMermaidCode(source))) {
        flushPending();
        pushChart(blocks, source, { sourceFormat: lang || "mermaid" });
      } else {
        pending.push(...fencedLines);
      }
      continue;
    }

    if (/^(?: {4}|\t)/.test(line)) {
      const indentedLines = [line];
      i += 1;
      for (; i < lines.length; i += 1) {
        if (!lines[i].trim() || /^(?: {4}|\t)/.test(lines[i])) {
          indentedLines.push(lines[i]);
          continue;
        }
        i -= 1;
        break;
      }
      const source = stripCodeIndent(indentedLines);
      if (looksLikeMermaidCode(source)) {
        flushPending();
        pushChart(blocks, source, { sourceFormat: "indented-mermaid" });
      } else {
        pending.push(...indentedLines);
      }
      continue;
    }

    pending.push(line);
  }

  flushPending();
  return blocks;
}

function mermaidMarkdown(source = "") {
  return `\`\`\`mermaid\n${String(source || "").trim()}\n\`\`\``;
}

export function renderContentBlocks(element, blocks = [], options = {}) {
  if (!element) return;
  const normalizedBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!normalizedBlocks.length) {
    element.textContent = "";
    return;
  }
  const live = Boolean(options.live);
  if (live || (normalizedBlocks.length === 1 && normalizedBlocks[0].type === "markdown")) {
    const text = normalizedBlocks[0]?.text || "";
    if (live) renderStreamingMarkdown(element, text);
    else renderMarkdownWithCache(element, text);
    return;
  }

  element.replaceChildren();
  for (const block of normalizedBlocks) {
    const node = document.createElement("div");
    node.className = `content-block content-block-${block.type || "unknown"}`;
    if (block.type === "artifact" && block.artifactType === "chart" && block.chartType === "mermaid") {
      node.classList.add("content-block-chart", "markdown-body");
      renderMarkdownWithCache(node, mermaidMarkdown(block.source));
    } else if (block.type === "markdown") {
      node.classList.add("markdown-body");
      renderMarkdownWithCache(node, block.text || "");
    } else {
      node.classList.add("content-block-unknown");
      node.textContent = block.text || block.source || "";
    }
    element.appendChild(node);
  }
}

export function renderMarkdownContent(element, markdownText = "", options = {}) {
  if (options.live) {
    renderContentBlocks(element, [{ type: "markdown", text: markdownText || "" }], options);
    return;
  }
  renderContentBlocks(element, markdownToContentBlocks(markdownText), options);
}
