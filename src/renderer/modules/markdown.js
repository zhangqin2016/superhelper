/**
 * Enhanced markdown rendering with syntax highlighting.
 * Uses highlight.js via dynamic ESM import.
 */

let hljsReady = false;
let hljs = null;

async function ensureHljs() {
  if (hljsReady) return hljs;
  try {
    const mod = await import("../../node_modules/highlight.js/es/index.js");
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
    element.textContent = markdownText || "";
    return;
  }

  const hl = await ensureHljs();
  const renderer = new window.marked.Renderer();
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    if (!href) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
  };

  if (hl) {
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

  const html = parser(markdownText || "", { renderer });

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

function hasHtmlTags(text) {
  return /<[a-zA-Z][^>]*>/.test(text);
}

/**
 * 纯文本追加，不走 Markdown 解析和 Sanitize。
 */
export function appendTextContent(element, text) {
  if (!element) return;
  element.textContent += text;
}

/**
 * 流式场景专用：对已渲染过的代码块复用缓存高亮结果。
 */
export function renderMarkdownWithCache(element, markdownText) {
  const parser = window.marked && (window.marked.parse || window.marked);
  if (typeof parser !== "function" || !window.DOMPurify) {
    element.textContent = markdownText || "";
    return { cached: false };
  }

  let cachedCount = 0;
  const renderer = new window.marked.Renderer();

  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    if (!href) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
  };

  renderer.code = function ({ text, lang }) {
    const key = hashContent(`${lang || ""}:${text}`);
    const cached = codeCache.get(key);
    if (cached) {
      cachedCount++;
      return cached;
    }
    let result;
    // 注意：此时 ensureHljs 可能尚未完成，用全局 window.hljs
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

  const html = parser(markdownText || "", { renderer });

  if (hasHtmlTags(html)) {
    element.innerHTML = window.DOMPurify.sanitize(html);
  } else {
    element.textContent = markdownText || "";
  }

  return { cached: cachedCount > 0, cachedCount };
}

/**
 * 清理代码高亮缓存（切换会话或清空对话时调用）。
 */
export function clearHighlightCache() {
  codeCache.clear();
}
