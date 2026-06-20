/**
 * Enhanced markdown rendering with syntax highlighting.
 * Uses highlight.js via dynamic ESM import.
 */
import { revealLocalFileInFolder } from "./file-reveal.js";
import { isMermaidLanguage, looksLikeMermaidCode, normalizeCodeLanguage, sanitizeMermaidSource } from "./mermaid-detect.js";
import morphdom from "../../../node_modules/morphdom/dist/morphdom-esm.js";

let hljsReady = false;
let hljs = null;
let katexReady = false;
let katex = null;
let mermaidReady = false;
let mermaid = null;

const MARKED_OPTIONS = { gfm: true, breaks: false };
const DIFF_LANGUAGES = new Set(["diff", "patch"]);
const LOCAL_FILE_EXTENSIONS = "png|jpe?g|gif|webp|bmp|svg|pdf|docx?|xlsx?|pptx?|csv|txt|md|json|html?|zip|tar|gz|mp4|mov|mp3|wav";
const LOCAL_FILE_PATH_RE = new RegExp(
  "(^|[\\s([{：:，,])((?:/|[A-Za-z]:[\\\\/])[^<>\\n\"'`]*?\\.(?:" + LOCAL_FILE_EXTENSIONS + "))(?![A-Za-z0-9._-])",
  "gi",
);

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

function prepareMarkdown(text = "", { mathRenderer = null } = {}) {
  return renderMathBlocks(repairMarkdownTables(text), mathRenderer);
}

function createMarkedRenderer({ hl = null, cacheCode = false } = {}) {
  const renderer = new window.marked.Renderer();
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const safeHref = sanitizeUrl(href, { allowRelative: true });
    if (!safeHref) return text;
    const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
    const localPath = localFilePathFromUrl(safeHref);
    const localAttrs = localPath
      ? ` class="markdown-local-file-link" data-local-file-path="${escapeAttribute(localPath)}"`
      : "";
    return `<a href="${escapeAttribute(safeHref)}"${localAttrs} target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
  };
  renderer.image = function ({ href, title, text }) {
    const safeSrc = sanitizeUrl(href, { allowRelative: true, image: true });
    const alt = escapeAttribute(text || "");
    if (!safeSrc) return alt;
    const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
    const localPath = localFilePathFromUrl(safeSrc);
    const localAttrs = localPath
      ? ` data-local-file-path="${escapeAttribute(localPath)}"`
      : "";
    const classes = localPath ? "markdown-image markdown-local-file-image" : "markdown-image";
    return `<img class="${classes}" src="${escapeAttribute(safeSrc)}" alt="${alt}" loading="lazy"${localAttrs}${titleAttr}>`;
  };

  renderer.code = function ({ text, lang }) {
    const normalizedLang = normalizeCodeLanguage(lang);
    const rich = renderRichCodeBlock(text, normalizedLang);
    if (rich) return rich;

    if (cacheCode) {
      const key = hashContent(`${normalizedLang || ""}:${text}`);
      const cached = codeCache.get(key);
      if (cached) return cached;
      const result = renderHighlightedCode(text, normalizedLang, window.hljs || hl);
      codeCache.set(key, result);
      return result;
    }

    return renderHighlightedCode(text, normalizedLang, hl);
  };
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

async function ensureKatex() {
  if (katexReady) return katex;
  try {
    const mod = await import("../../../node_modules/katex/dist/katex.mjs");
    katex = mod.default || mod;
    katexReady = true;
    return katex;
  } catch {
    katexReady = true;
    return null;
  }
}

async function ensureMermaid() {
  if (mermaidReady) return mermaid;
  try {
    const mod = await import("../../../node_modules/mermaid/dist/mermaid.esm.mjs");
    mermaid = mod.default || mod;
    const root = globalThis.document?.documentElement;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: root?.classList?.contains("light") ? "default" : "dark",
    });
    mermaidReady = true;
    return mermaid;
  } catch {
    mermaidReady = true;
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

  const [hl, mathRenderer] = await Promise.all([ensureHljs(), ensureKatex()]);
  const renderer = createMarkedRenderer({ hl });
  const html = parser(prepareMarkdown(markdownText || "", { mathRenderer }), { ...MARKED_OPTIONS, renderer });

  element.innerHTML = window.DOMPurify.sanitize(html);
  enhanceRenderedMarkdown(element, { interactive: true });
  await renderMermaidBlocks(element);
}

function escapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sanitizeUrl(value, { allowRelative = false, image = false } = {}) {
  const href = String(value || "").trim();
  if (!href) return "";
  if (allowRelative && (href.startsWith("/") || href.startsWith("#"))) {
    return href;
  }
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^file:/i.test(href)) return href;
  if (image && href.startsWith("data:image/")) return href;
  if (image && /^(file:|blob:)/i.test(href)) return href;
  try {
    const url = new URL(href, window.location?.href || "file:///");
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return href;
    if (url.protocol === "file:" && localFilePathFromUrl(href)) return href;
    if (image && (url.protocol === "file:" || url.protocol === "blob:")) return href;
  } catch {}
  return "";
}

function localFilePathFromUrl(value = "") {
  const href = String(value || "").trim();
  if (!href || href.startsWith("#")) return "";
  if (/^file:/i.test(href)) {
    try {
      new URL(href);
      return href;
    } catch {
      return "";
    }
  }
  if (/^\/(?!\/)/.test(href)) return href;
  if (/^[A-Za-z]:[\\/]/.test(href)) return href;
  return "";
}

function renderRichCodeBlock(text = "", lang = "") {
  if (DIFF_LANGUAGES.has(lang)) return renderDiffBlock(text);
  if (isMermaidLanguage(lang) || (!lang && looksLikeMermaidCode(text))) {
    return `<pre class="markdown-mermaid-source"><code class="language-mermaid">${escapeHtml(text)}</code></pre>`;
  }
  return null;
}

function renderHighlightedCode(text = "", lang = "", highlighter = null) {
  if (highlighter && lang && highlighter.getLanguage?.(lang)) {
    try {
      const highlighted = highlighter.highlight(text, { language: lang }).value;
      return `<pre><code class="hljs language-${escapeAttribute(lang)}">${highlighted}</code></pre>`;
    } catch {}
  }
  if (highlighter?.highlightAuto) {
    try {
      const auto = highlighter.highlightAuto(text).value;
      return `<pre><code class="hljs">${auto}</code></pre>`;
    } catch {}
  }
  const languageClass = lang ? ` class="language-${escapeAttribute(lang)}"` : "";
  return `<pre><code${languageClass}>${escapeHtml(text)}</code></pre>`;
}

function renderDiffBlock(text = "") {
  const lines = String(text).split("\n");
  const rendered = lines.map((line) => {
    let kind = "context";
    if (line.startsWith("+") && !line.startsWith("+++")) kind = "add";
    else if (line.startsWith("-") && !line.startsWith("---")) kind = "del";
    else if (line.startsWith("@@")) kind = "hunk";
    else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) kind = "meta";
    return `<span class="markdown-diff-line markdown-diff-${kind}">${escapeHtml(line || " ")}</span>`;
  }).join("");
  return `<pre class="markdown-diff"><code>${rendered}</code></pre>`;
}

function renderMathBlocks(text = "", mathRenderer = null) {
  if (!mathRenderer || typeof mathRenderer.renderToString !== "function") return text;
  let prepared = String(text);
  prepared = prepared.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    return `\n<div class="markdown-math-block">${renderMath(expr, mathRenderer, true)}</div>\n`;
  });
  prepared = prepared.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => {
    return `\n<div class="markdown-math-block">${renderMath(expr, mathRenderer, true)}</div>\n`;
  });
  prepared = prepared.replace(/\\\(([^]+?)\\\)/g, (_, expr) => {
    return `<span class="markdown-math-inline">${renderMath(expr, mathRenderer, false)}</span>`;
  });
  prepared = prepared.replace(/(^|[\s([:：，。；；,])\$([^$\n]{1,500})\$(?=([\s)\].,;!?，。；！？]|$))/g, (match, prefix, expr) => {
    if (/^\s*$/.test(expr)) return match;
    return `${prefix}<span class="markdown-math-inline">${renderMath(expr, mathRenderer, false)}</span>`;
  });
  return prepared;
}

function renderMath(expr, mathRenderer, displayMode) {
  try {
    return mathRenderer.renderToString(String(expr).trim(), {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: "ignore",
    });
  } catch {
    return escapeHtml(String(expr));
  }
}

async function renderMermaidBlocks(element) {
  if (!element?.querySelectorAll) return;
  const blocks = Array.from(element.querySelectorAll("pre.markdown-mermaid-source > code.language-mermaid"));
  if (!blocks.length) return;
  const engine = await ensureMermaid();
  for (const code of blocks) {
    const source = sanitizeMermaidSource(code.textContent || "");
    const pre = code.closest("pre");
    if (!pre) continue;
    const container = document.createElement("div");
    container.className = "markdown-mermaid";
    container.textContent = "Rendering diagram...";
    pre.replaceWith(container);
    if (!engine) {
      container.classList.add("markdown-mermaid-error");
      container.textContent = source;
      continue;
    }
    try {
      const id = `lily_mermaid_${Math.abs(Number(hashContent(source)))}_${Date.now()}`;
      const result = await engine.render(id, source);
      container.innerHTML = window.DOMPurify.sanitize(result.svg || "");
    } catch (error) {
      console.warn("[markdown] Mermaid render failed", error);
      container.classList.add("markdown-mermaid-error");
      container.textContent = source;
    }
  }
}

function scheduleMermaidRender(element) {
  if (!element?.querySelectorAll) return;
  if (!element.querySelectorAll("pre.markdown-mermaid-source > code.language-mermaid").length) return;
  const schedule = typeof queueMicrotask === "function" ? queueMicrotask : (fn) => setTimeout(fn, 0);
  schedule(() => { void renderMermaidBlocks(element); });
}

function wireMarkdownImages(element) {
  if (!element?.querySelectorAll) return;
  for (const image of element.querySelectorAll("img.markdown-image")) {
    if (image.dataset.viewerReady === "true") continue;
    image.dataset.viewerReady = "true";
    image.addEventListener("click", async () => {
      const localPath = image.dataset.localFilePath || "";
      if (localPath) {
        await revealLocalFileInFolder(localPath, markdownSessionId(image));
        return;
      }
      try {
        const mod = await import("./image-viewer.js");
        mod.openImageViewer?.(image.currentSrc || image.src, image.alt || "");
      } catch {}
    });
  }
}

function wireMarkdownLocalFileLinks(element) {
  if (!element?.querySelectorAll) return;
  for (const link of element.querySelectorAll("a.markdown-local-file-link[data-local-file-path]")) {
    if (link.dataset.revealReady === "true") continue;
    link.dataset.revealReady = "true";
    link.title ||= link.dataset.localFilePath || "";
    link.addEventListener("click", (event) => {
      const filePath = link.dataset.localFilePath || "";
      if (!filePath) return;
      event.preventDefault();
      void revealLocalFileInFolder(filePath, markdownSessionId(link));
    });
  }
}

function markdownSessionId(node) {
  return node?.closest?.("[data-session-id]")?.dataset?.sessionId || "";
}

function shouldSkipPathAutolink(node) {
  const parent = node?.parentElement;
  if (!parent) return true;
  return Boolean(parent.closest("a, code, pre, button, textarea, input, script, style, .markdown-code-frame"));
}

function autolinkLocalFilePaths(element) {
  if (!element?.ownerDocument?.createTreeWalker) return;
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!shouldSkipPathAutolink(node) && LOCAL_FILE_PATH_RE.test(node.nodeValue || "")) {
      nodes.push(node);
    }
    LOCAL_FILE_PATH_RE.lastIndex = 0;
  }

  for (const node of nodes) {
    const text = node.nodeValue || "";
    const fragment = element.ownerDocument.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(LOCAL_FILE_PATH_RE)) {
      const prefix = match[1] || "";
      const rawPath = match[2] || "";
      const start = (match.index || 0) + prefix.length;
      if (start > lastIndex) fragment.append(text.slice(lastIndex, start));
      const link = element.ownerDocument.createElement("a");
      link.className = "markdown-local-file-link";
      link.href = rawPath;
      link.dataset.localFilePath = rawPath;
      link.textContent = rawPath;
      fragment.append(link);
      lastIndex = start + rawPath.length;
    }
    if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
    node.parentNode?.replaceChild(fragment, node);
  }
}

function enhanceRenderedMarkdown(element, { interactive = false } = {}) {
  wireMarkdownImages(element);
  autolinkLocalFilePaths(element);
  wireMarkdownLocalFileLinks(element);
  normalizeTaskLists(element);
  if (interactive) wireCodeCopyButtons(element);
}

function normalizeTaskLists(element) {
  if (!element?.querySelectorAll) return;
  for (const checkbox of element.querySelectorAll('li > input[type="checkbox"]')) {
    const item = checkbox.closest("li");
    item?.classList.add("markdown-task-list-item");
    checkbox.disabled = true;
  }
}

function wireCodeCopyButtons(element) {
  if (!element?.querySelectorAll) return;
  for (const pre of element.querySelectorAll("pre")) {
    if (pre.classList.contains("markdown-mermaid-source")) continue;
    if (pre.closest(".markdown-code-frame")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;

    const frame = document.createElement("div");
    frame.className = "markdown-code-frame";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "markdown-code-copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("click", async () => {
      const text = code.textContent || "";
      const ok = await copyText(text);
      button.textContent = ok ? "Copied" : "Copy failed";
      button.classList.toggle("is-error", !ok);
      setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("is-error");
      }, 1400);
    });

    pre.parentNode?.insertBefore(frame, pre);
    frame.append(pre, button);
  }
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
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
  const html = parser(prepareMarkdown(markdownText, { mathRenderer: window.katex || katex }), { ...MARKED_OPTIONS, renderer });
  const sanitized = window.DOMPurify.sanitize(html);
  // Patch in place via morphdom instead of replacing innerHTML: streaming text
  // grows by extending the trailing nodes, so the block doesn't tear down and
  // rebuild every tick — no flicker, smooth incremental output.
  const next = document.createElement(element.tagName || "DIV");
  next.innerHTML = sanitized;
  morphdom(element, next, { childrenOnly: true });
  enhanceRenderedMarkdown(element, { interactive: false });
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

  const html = parser(prepareMarkdown(markdownText || "", { mathRenderer: window.katex || katex }), { ...MARKED_OPTIONS, renderer });

  element.innerHTML = window.DOMPurify.sanitize(html);
  enhanceRenderedMarkdown(element, { interactive: true });
  scheduleMermaidRender(element);
  if (element.dataset) delete element.dataset.streamMode;

  return { cached: cachedCount > 0, cachedCount };
}

/**
 * 清理代码高亮缓存（切换会话或清空对话时调用）。
 */
export function clearHighlightCache() {
  codeCache.clear();
}
