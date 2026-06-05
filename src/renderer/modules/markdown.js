/**
 * Enhanced markdown rendering with syntax highlighting.
 * Uses highlight.js via dynamic ESM import.
 */

let hljsReady = false;
let hljs = null;

const MARKED_OPTIONS = { gfm: true, breaks: false };

function isTableSeparatorLine(line = "") {
  const trimmed = String(line).trim();
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(trimmed);
}

function isTableRowLine(line = "") {
  const trimmed = String(line).trim();
  if (!trimmed.includes("|")) return false;
  return pipeColumnCount(trimmed) >= 2;
}

function pipeColumnCount(line = "") {
  let inner = String(line).trim();
  if (!inner.includes("|")) return 0;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").length;
}

function makeTableSeparator(columnCount) {
  const cols = Math.max(2, columnCount);
  return `| ${Array(cols).fill("---").join(" | ")} |`;
}

/** Insert a GFM separator row when models omit it between header and body rows. */
export function repairMarkdownTables(text = "") {
  const lines = String(text).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!isTableRowLine(line) && !isTableSeparatorLine(line)) {
      out.push(line);
      i++;
      continue;
    }
    const block = [];
    while (i < lines.length && (isTableRowLine(lines[i]) || isTableSeparatorLine(lines[i]))) {
      block.push(lines[i]);
      i++;
    }
    if (!block.length) continue;
    out.push(block[0]);
    if (block.length >= 2 && isTableSeparatorLine(block[1])) {
      for (let j = 1; j < block.length; j++) out.push(block[j]);
      continue;
    }
    if (block.length >= 2) {
      out.push(makeTableSeparator(pipeColumnCount(block[0])));
      for (let j = 1; j < block.length; j++) out.push(block[j]);
      continue;
    }
    out.push(block[0]);
  }
  return out.join("\n");
}

function prepareMarkdown(text = "") {
  return repairMarkdownTables(text);
}

function createMarkedRenderer({ hl = null, cacheCode = false } = {}) {
  const renderer = new window.marked.Renderer();
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    if (!href) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
  };

  if (cacheCode) {
    renderer.code = function ({ text, lang }) {
      const key = hashContent(`${lang || ""}:${text}`);
      const cached = codeCache.get(key);
      if (cached) {
        return cached;
      }
      let result;
      if (window.hljs && lang && window.hljs.getLanguage(lang)) {
        try {
          result = `<pre><code class="hljs language-${lang}">${window.hljs.highlight(text, { language: lang }).value}</code></pre>`;
        } catch {
          result = `<pre><code>${escapeHtml(text)}</code></pre>`;
        }
      } else {
        result = `<pre><code>${escapeHtml(text)}</code></pre>`;
      }
      codeCache.set(key, result);
      return result;
    };
  } else if (hl) {
    renderer.code = function ({ text, lang }) {
      if (lang && hl.getLanguage(lang)) {
        try {
          const highlighted = hl.highlight(text, { language: lang }).value;
          return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
        } catch {}
      }
      try {
        const auto = hl.highlightAuto(text).value;
        return `<pre><code class="hljs">${auto}</code></pre>`;
      } catch {
        return `<pre><code>${escapeHtml(text)}</code></pre>`;
      }
    };
  }
  return renderer;
}

async function ensureHljs() {
  if (hljsReady) return hljs;
  try {
    const mod = await import("../../../node_modules/highlight.js/es/index.js");
    hljs = mod.default || mod;
    hljsReady = true;
    return hljs;
  } catch {
    hljsReady = true;
    return null;
  }
}

export async function renderMarkdown(element, markdownText) {
  const parser = window.marked && (window.marked.parse || window.marked);
  if (typeof parser !== "function" || !window.DOMPurify) {
    element.classList?.add("markdown-fallback");
    element.textContent = markdownText || "";
    return;
  }
  element.classList?.remove("markdown-fallback");

  const hl = await ensureHljs();
  const renderer = createMarkedRenderer({ hl });
  const html = parser(prepareMarkdown(markdownText || ""), { ...MARKED_OPTIONS, renderer });

  element.innerHTML = window.DOMPurify.sanitize(html);
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- 新增：流式渲染优化 ---

/** @type {Map<string, string>} 代码块内容hash → 已高亮的HTML */
const codeCache = new Map();

function hashContent(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/**
 * 纯文本追加，不走 Markdown 解析和 Sanitize。
 */
export function appendTextContent(element, text) {
  if (!element) return;
  element.textContent += text;
}

/**
 * Streaming text must not rebuild the bubble DOM on every token. Keep it as a
 * plain text stream, then run full Markdown parsing once the turn completes.
 */
export function appendStreamingText(element, text) {
  if (!element) return;
  const piece = String(text ?? "");
  if (!piece) return;
  element.textContent = `${element.textContent || ""}${piece}`;
  if (element.dataset) element.dataset.streamMode = "text";
}

/**
 * Lightweight markdown render for streaming. Unlike renderMarkdown,
 * this does NOT await highlight.js — code blocks render without syntax
 * highlighting, keeping the render synchronous and fast. Full highlight
 * is deferred to renderMarkdownWithCache at turn completion.
 */
export function renderStreamingMarkdown(element, markdownText) {
  if (!element || !markdownText) return;
  const parser = window.marked && (window.marked.parse || window.marked);
  if (typeof parser !== "function" || !window.DOMPurify) {
    element.textContent = markdownText;
    element.classList?.add("markdown-fallback");
    return;
  }
  element.classList?.remove("markdown-fallback");

  const renderer = createMarkedRenderer();
  const html = parser(prepareMarkdown(markdownText), { ...MARKED_OPTIONS, renderer });
  element.innerHTML = window.DOMPurify.sanitize(html);
  if (element.dataset) element.dataset.streamMode = "rendered";
}

/**
 * 流式场景专用：对已渲染过的代码块复用缓存高亮结果。
 */
export function renderMarkdownWithCache(element, markdownText) {
  const parser = window.marked && (window.marked.parse || window.marked);
  if (typeof parser !== "function" || !window.DOMPurify) {
    element.classList?.add("markdown-fallback");
    element.textContent = markdownText || "";
    return { cached: false };
  }
  element.classList?.remove("markdown-fallback");

  let cachedCount = 0;
  const renderer = createMarkedRenderer({ cacheCode: true });
  const originalCode = renderer.code;
  renderer.code = function (args) {
    const key = hashContent(`${args.lang || ""}:${args.text}`);
    if (codeCache.has(key)) cachedCount++;
    return originalCode.call(this, args);
  };

  const html = parser(prepareMarkdown(markdownText || ""), { ...MARKED_OPTIONS, renderer });

  element.innerHTML = window.DOMPurify.sanitize(html);
  if (element.dataset) delete element.dataset.streamMode;

  return { cached: cachedCount > 0, cachedCount };
}

/**
 * 清理代码高亮缓存（切换会话或清空对话时调用）。
 */
export function clearHighlightCache() {
  codeCache.clear();
}
