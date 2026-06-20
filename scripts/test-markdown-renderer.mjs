import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { marked } from "marked";

const source = fs
  .readFileSync(new URL("../src/renderer/modules/markdown.js", import.meta.url), "utf8")
  .replace('import morphdom from "../../../node_modules/morphdom/dist/morphdom-esm.js";', "")
  .replace('import { revealLocalFileInFolder } from "./file-reveal.js";', "")
  .replace('import { isMermaidLanguage, looksLikeMermaidCode, normalizeCodeLanguage, sanitizeMermaidSource } from "./mermaid-detect.js";', "")
  .replaceAll("export async function", "async function")
  .replaceAll("export function", "function");

const MERMAID_START_RE = /^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|requirementDiagram|gitGraph|C4Context|sankey-beta|xychart-beta|block-beta|packet-beta)\b/;
const MERMAID_LANGUAGES = new Set([
  "mermaid",
  "flowchart",
  "sequence",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "pieChart",
]);
const context = {
  console,
  URL,
  // markdown.js patches streaming output in place via morphdom; stub it to the
  // observable result (childrenOnly → element HTML becomes the next HTML).
  morphdom(fromEl, toEl, opts) {
    if (fromEl && toEl) {
      fromEl.innerHTML = opts && opts.childrenOnly ? toEl.innerHTML : (typeof toEl === "string" ? toEl : toEl.innerHTML);
    }
    return fromEl;
  },
  normalizeCodeLanguage(lang = "") {
    return String(lang || "").trim().split(/\s+/)[0];
  },
  looksLikeMermaidCode(source = "") {
    const firstLine = String(source).split("\n").map((line) => line.trim()).find(Boolean) || "";
    return MERMAID_START_RE.test(firstLine);
  },
  sanitizeMermaidSource(source = "") {
    return String(source)
      .split("\n")
      .filter((line) => !/^\s*\|[\s|:-]*\|\s*$/.test(line))
      .join("\n")
      .trim();
  },
  isMermaidLanguage(lang = "") {
    return MERMAID_LANGUAGES.has(String(lang || "").trim().split(/\s+/)[0]);
  },
  revealLocalFileInFolder() {
    return Promise.resolve({ ok: true });
  },
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

const localLink = fakeElement();
context.window.__test.renderMarkdownWithCache(localLink, "[报告](/Users/zhangqin/out/report.docx)");
assert.match(localLink.innerHTML, /class="markdown-local-file-link"/);
assert.match(localLink.innerHTML, /data-local-file-path="\/Users\/zhangqin\/out\/report\.docx"/);

const fileUrlLink = fakeElement();
context.window.__test.renderMarkdownWithCache(fileUrlLink, "[报告](file:///Users/zhangqin/out/report.docx)");
assert.match(fileUrlLink.innerHTML, /class="markdown-local-file-link"/);
assert.match(fileUrlLink.innerHTML, /data-local-file-path="file:\/\/\/Users\/zhangqin\/out\/report\.docx"/);

const relativeGeneratedPath = fakeElement();
context.window.__test.renderMarkdownWithCache(relativeGeneratedPath, "已保存到：generated-assets/image-1-2026.png");
assert.doesNotMatch(relativeGeneratedPath.innerHTML, /markdown-local-file-link/);

const localImage = fakeElement();
context.window.__test.renderMarkdownWithCache(localImage, "![生成图](/Users/zhangqin/out/image.png)");
assert.match(localImage.innerHTML, /class="markdown-image markdown-local-file-image"/);
assert.match(localImage.innerHTML, /data-local-file-path="\/Users\/zhangqin\/out\/image\.png"/);

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

const mermaidPie = fakeElement();
context.window.__test.renderMarkdownWithCache(
  mermaidPie,
  "```pie\npie showData\n    title 攻击类型分布\n    \"Rocket\" : 16\n```",
);
assert.match(mermaidPie.innerHTML, /markdown-mermaid-source/);
assert.match(mermaidPie.innerHTML, /language-mermaid/);
assert.doesNotMatch(mermaidPie.innerHTML, /language-pie/);

const indentedMermaidPie = fakeElement();
context.window.__test.renderMarkdownWithCache(
  indentedMermaidPie,
  "地点分布\n\n    pie showData\n        title 事件发生地点分布\n        \"Abu Dhabi\" : 8\n",
);
assert.match(indentedMermaidPie.innerHTML, /markdown-mermaid-source/);
assert.match(indentedMermaidPie.innerHTML, /language-mermaid/);
assert.doesNotMatch(indentedMermaidPie.innerHTML, /<code>pie showData/);

console.log("markdown-renderer: ok");
