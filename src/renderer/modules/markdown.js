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
