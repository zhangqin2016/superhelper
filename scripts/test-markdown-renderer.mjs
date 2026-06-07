import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { marked } from "marked";

const source = fs
  .readFileSync(new URL("../src/renderer/modules/markdown.js", import.meta.url), "utf8")
  .replaceAll("export async function", "async function")
  .replaceAll("export function", "function");

const context = {
  console,
  window: {
    marked,
    DOMPurify: {
      sanitize(html) {
        return html;
      },
    },
    katex: {
      renderToString(expr, options) {
        return `<span class="katex" data-display="${options.displayMode ? "1" : "0"}">${expr}</span>`;
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(`${source}\nwindow.__test = { appendStreamingText, renderMarkdownWithCache, renderMarkdown, repairMarkdownTables };`, context);

function fakeElement() {
  const classes = new Set();
  return {
    innerHTML: "",
    textContent: "",
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
  };
}

const bold = fakeElement();
context.window.__test.renderMarkdownWithCache(bold, "请提供 **出生日期** 和 **出生地点**。");
assert.match(bold.innerHTML, /<strong>出生日期<\/strong>/);
assert.match(bold.innerHTML, /<strong>出生地点<\/strong>/);
assert.equal(bold.textContent, "");

const list = fakeElement();
context.window.__test.renderMarkdownWithCache(list, "- 第一项\n- 第二项");
assert.match(list.innerHTML, /<ul>/);
assert.match(list.innerHTML, /<li>第一项<\/li>/);

const plain = fakeElement();
context.window.__test.renderMarkdownWithCache(plain, "普通文本");
assert.match(plain.innerHTML, /普通文本/);
assert.equal(plain.textContent, "");

const streaming = fakeElement();
streaming.dataset = {};
context.window.__test.appendStreamingText(streaming, "请提供 **");
context.window.__test.appendStreamingText(streaming, "出生日期**");
assert.equal(streaming.textContent, "请提供 **出生日期**");
assert.equal(streaming.innerHTML, "");
assert.equal(streaming.dataset.streamMode, "text");
context.window.__test.renderMarkdownWithCache(streaming, streaming.textContent);
assert.match(streaming.innerHTML, /<strong>出生日期<\/strong>/);
assert.equal(streaming.dataset.streamMode, undefined);

const withoutParser = fakeElement();
const savedMarked = context.window.marked;
context.window.marked = null;
context.window.__test.renderMarkdownWithCache(withoutParser, "### 标题\n\n- 第一项");
assert.equal(withoutParser.textContent, "### 标题\n\n- 第一项");
assert.equal(withoutParser.classList.contains("markdown-fallback"), true);
context.window.marked = savedMarked;

const repaired = context.window.__test.repairMarkdownTables(
  "| 项目 | 状态 |\n| 📖 小说 | 100章完结 |",
);
assert.match(repaired, /\| --- \| --- \|/);

const table = fakeElement();
context.window.__test.renderMarkdownWithCache(
  table,
  "| 项目 | 状态 |\n| 📖 小说 | 100章完结 |",
);
assert.match(table.innerHTML, /<table>/);
assert.match(table.innerHTML, /<th>项目<\/th>/);
assert.match(table.innerHTML, /<td>📖 小说<\/td>/);

const diff = fakeElement();
context.window.__test.renderMarkdownWithCache(diff, "```diff\n-旧内容\n+新内容\n@@ line\n```");
assert.match(diff.innerHTML, /markdown-diff/);
assert.match(diff.innerHTML, /markdown-diff-del/);
assert.match(diff.innerHTML, /markdown-diff-add/);
assert.match(diff.innerHTML, /markdown-diff-hunk/);

const image = fakeElement();
context.window.__test.renderMarkdownWithCache(image, "![截图](https://example.com/bug.png)");
assert.match(image.innerHTML, /class="markdown-image"/);
assert.match(image.innerHTML, /loading="lazy"/);

const unsafeLink = fakeElement();
context.window.__test.renderMarkdownWithCache(unsafeLink, "[危险](javascript:alert(1))");
assert.doesNotMatch(unsafeLink.innerHTML, /href="javascript:/);

const math = fakeElement();
context.window.__test.renderMarkdownWithCache(math, "公式：$a^2+b^2=c^2$\n\n$$E=mc^2$$");
assert.match(math.innerHTML, /class="markdown-math-inline"/);
assert.match(math.innerHTML, /class="markdown-math-block"/);
assert.match(math.innerHTML, /class="katex"/);

const mermaid = fakeElement();
context.window.__test.renderMarkdownWithCache(mermaid, "```mermaid\ngraph TD\nA-->B\n```");
assert.match(mermaid.innerHTML, /markdown-mermaid-source/);
assert.match(mermaid.innerHTML, /language-mermaid/);

console.log("markdown-renderer: ok");
