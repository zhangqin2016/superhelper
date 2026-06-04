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
  },
};
vm.createContext(context);
vm.runInContext(`${source}\nwindow.__test = { renderMarkdownWithCache, renderMarkdown };`, context);

function fakeElement() {
  return {
    innerHTML: "",
    textContent: "",
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

console.log("markdown-renderer: ok");
