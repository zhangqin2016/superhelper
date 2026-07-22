import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { marked } from "marked";

const segmentsSource = fs
  .readFileSync(new URL("../src/renderer/modules/markdown-math-segments.js", import.meta.url), "utf8")
  .replaceAll("export function", "function");
const streamBlocksSource = fs
  .readFileSync(new URL("../src/renderer/modules/markdown-stream-blocks.js", import.meta.url), "utf8")
  .replaceAll("export function", "function");

const source = fs
  .readFileSync(new URL("../src/renderer/modules/markdown.js", import.meta.url), "utf8")
  .replace('import morphdom from "../../../node_modules/morphdom/dist/morphdom-esm.js";', "")
  .replace('import { revealLocalFileInFolder } from "./file-reveal.js";', "")
  .replace('import { isMermaidLanguage, looksLikeMermaidCode, normalizeCodeLanguage, sanitizeMermaidSource } from "./mermaid-detect.js";', "")
  .replace('import { t } from "../i18n/index.js";', "")
  .replace('import { mapPlainSegments } from "./markdown-math-segments.js";', "")
  .replace('import { renderStreamBlocks } from "./markdown-stream-blocks.js";', "")
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
  t(key, params = {}) {
    if (key === "markdown.codeCollapseLines") return `${params.count} 行`;
    if (key === "markdown.codeExpand") return "展开";
    if (key === "markdown.codeCollapseAction") return "收起";
    return key;
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
vm.runInContext(`${segmentsSource}\n${streamBlocksSource}\n${source}\nwindow.__test = { appendStreamingText, renderStreamingMarkdown, renderMarkdownWithCache, renderMarkdown, repairMarkdownTables };`, context);

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

// GFM allows 1+ hyphens in delimiter cells (`:--:`); marked needs 3+. Short
// dashes are upgraded so the delimiter never leaks into the rendered table as
// a visible data row.
{
  const short = context.window.__test.repairMarkdownTables(
    "| 排名 | 国家 | 夺冠次数 |\n| :--: | ------ | :--: |\n| 1 | 巴西 | 5次 |",
  );
  assert.match(short, /\| :---: \| ------ \| :---: \|/, "short delimiter dashes upgrade to 3+");
  assert(!/^ *\| *:--:/m.test(short), "no short-dash delimiter survives");
  const shortTable = fakeElement();
  context.window.__test.renderMarkdownWithCache(
    shortTable,
    "| 排名 | 国家 |\n| :--: | ------ |\n| 1 | 巴西 |",
  );
  assert.match(shortTable.innerHTML, /<table>/);
  assert(!shortTable.innerHTML.includes(":--:"), "delimiter row must not render as a data row");
}

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
assert.match(localImage.innerHTML, /src="app-file:\/\/media\/%2FUsers%2Fzhangqin%2Fout%2Fimage\.png"/);

const localFileUrlImage = fakeElement();
context.window.__test.renderMarkdownWithCache(localFileUrlImage, "![生成图](file:///Users/zhangqin/out/image.png)");
assert.match(localFileUrlImage.innerHTML, /class="markdown-image markdown-local-file-image"/);
assert.match(localFileUrlImage.innerHTML, /data-local-file-path="file:\/\/\/Users\/zhangqin\/out\/image\.png"/);
assert.match(localFileUrlImage.innerHTML, /src="app-file:\/\/media\/%2FUsers%2Fzhangqin%2Fout%2Fimage\.png"/);

const unsafeLink = fakeElement();
context.window.__test.renderMarkdownWithCache(unsafeLink, "[危险](javascript:alert(1))");
assert.doesNotMatch(unsafeLink.innerHTML, /href="javascript:/);

const math = fakeElement();
context.window.__test.renderMarkdownWithCache(math, "公式：$a^2+b^2=c^2$\n\n$$E=mc^2$$");
assert.match(math.innerHTML, /class="markdown-math-inline"/);
assert.match(math.innerHTML, /class="markdown-math-block"/);
assert.match(math.innerHTML, /class="katex"/);

// Math preprocessing must never touch code: `$...$` inside fences and inline
// spans is literal code, not a formula. Before segmentation, the fenced `$x$`
// became KaTeX HTML that marked escaped into garbled text.
const mathInFence = fakeElement();
context.window.__test.renderMarkdownWithCache(mathInFence, "```js\nconst price = $a + $b;\n```");
assert.doesNotMatch(mathInFence.innerHTML, /markdown-math-inline/, "no math inside fenced code");
assert.match(mathInFence.innerHTML, /\$a \+ \$b/, "code keeps its literal $...$ text");

const mathInInlineCode = fakeElement();
context.window.__test.renderMarkdownWithCache(mathInInlineCode, "用 `$x + y$` 表示求和，而 $x + y$ 是公式");
assert.match(mathInInlineCode.innerHTML, /<code>\$x \+ y\$<\/code>/, "inline code keeps literal math text");
assert.match(mathInInlineCode.innerHTML, /class="markdown-math-inline"/, "real formula still renders");

const mathAroundFence = fakeElement();
context.window.__test.renderMarkdownWithCache(mathAroundFence, "$a=1$\n\n```txt\n$b=2$\n```\n\n$c=3$");
assert.equal(mathAroundFence.innerHTML.match(/markdown-math-inline/g).length, 2, "math renders outside the fence only");

// Streaming: repeated renders of a growing answer stay correct end-to-end
// (prefix cache + tail parse + morphdom patch), including code fences that
// span multiple ticks.
const streamEl = fakeElement();
streamEl.dataset = {};
context.document = { createElement: () => fakeElement() };
context.window.__test.renderStreamingMarkdown(streamEl, "第一段\n\n第二段");
assert.match(streamEl.innerHTML, /第一段/);
assert.match(streamEl.innerHTML, /第二段/);
context.window.__test.renderStreamingMarkdown(streamEl, "第一段\n\n第二段继续生长\n\n第三段");
assert.match(streamEl.innerHTML, /第二段继续生长/);
assert.match(streamEl.innerHTML, /第三段/);
context.window.__test.renderStreamingMarkdown(streamEl, "第一段\n\n```js\nconst a = 1;\n```\n\n结尾 $x+y$");
assert.match(streamEl.innerHTML, /const a = 1;/);
assert.match(streamEl.innerHTML, /markdown-math-inline/);

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

// Long-code collapse card: walls of code render as a compact expandable header
// so plans/answers read as decisions, not code dumps.
const longCode = Array.from({ length: 24 }, (_, i) => `const line${i} = ${i};`).join("\n");
const collapsed = fakeElement();
context.window.__test.renderMarkdownWithCache(collapsed, `说明文字\n\n\`\`\`js\n${longCode}\n\`\`\``);
assert.match(collapsed.innerHTML, /<details class="markdown-code-collapse"/, "long code blocks collapse");
assert.match(collapsed.innerHTML, /markdown-code-collapse-lang">js</, "the header names the language");
assert.match(collapsed.innerHTML, /24 行/, "the header shows the line count");
assert.match(collapsed.innerHTML, /const line0 = 0;/, "the first-line snippet previews the code");
assert.match(collapsed.innerHTML, /data-expand="展开"/, "toggle labels are localized via data attributes");
assert.doesNotMatch(collapsed.innerHTML, /<details[^>]*open/, "collapse HTML is deterministic (open state lives in the DOM, not the cache)");

const shortCode = fakeElement();
context.window.__test.renderMarkdownWithCache(shortCode, "```js\nconst a = 1;\nconst b = 2;\n```");
assert.doesNotMatch(shortCode.innerHTML, /markdown-code-collapse/, "short snippets stay inline");

const longMermaid = fakeElement();
const mermaidBody = `graph TD\n${Array.from({ length: 20 }, (_, i) => `  A${i} --> A${i + 1}`).join("\n")}`;
context.window.__test.renderMarkdownWithCache(longMermaid, `\`\`\`mermaid\n${mermaidBody}\n\`\`\``);
assert.doesNotMatch(longMermaid.innerHTML, /markdown-code-collapse/, "mermaid renders as a diagram — never collapsed");

const longDiff = fakeElement();
const diffBody = Array.from({ length: 20 }, (_, i) => `+added line ${i}`).join("\n");
context.window.__test.renderMarkdownWithCache(longDiff, `\`\`\`diff\n${diffBody}\n\`\`\``);
assert.match(longDiff.innerHTML, /markdown-code-collapse/, "long diffs are code walls too — collapsed");
assert.match(longDiff.innerHTML, /markdown-diff/, "the collapsed body keeps the diff rendering");

// Cached second render must still be wrapped (cache stores the UNWRAPPED highlight).
const collapsedAgain = fakeElement();
context.window.__test.renderMarkdownWithCache(collapsedAgain, `说明文字\n\n\`\`\`js\n${longCode}\n\`\`\``);
assert.match(collapsedAgain.innerHTML, /<details class="markdown-code-collapse"/, "cache-hit renders stay collapsed");

console.log("markdown-renderer: ok");
