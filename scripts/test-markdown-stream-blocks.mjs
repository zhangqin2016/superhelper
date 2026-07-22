import assert from "node:assert/strict";
import { stableStreamPrefix, renderStreamBlocks } from "../src/renderer/modules/markdown-stream-blocks.js";

// --- stableStreamPrefix: boundary detection ---

// Cuts after the last blank line; the trailing partial block is unstable.
{
  const text = "第一段\n\n第二段\n\n第三段还在写";
  assert.equal(stableStreamPrefix(text), "第一段\n\n第二段\n\n");
}

// No blank line → nothing stable.
assert.equal(stableStreamPrefix("只有一段还没写完"), "");

// An unclosed code fence freezes the boundary at the fence start.
{
  const text = "前文\n\n```js\nconst a = 1;\n\n这行在围栏里\n";
  assert.equal(stableStreamPrefix(text), "前文\n\n");
}

// Fence balance is content-aware: a ``` line inside a fence is not a new fence.
{
  const text = "```md\n示例：\n```js\n内层\n```\n\n围栏内空行\n```\n\n后续";
  assert.equal(stableStreamPrefix(text), "```md\n示例：\n```js\n内层\n```\n\n围栏内空行\n```\n\n");
}

// Tilde fences work too, and a longer closing fence is valid.
{
  const text = "~~~py\nx = 1\n~~~~\n\n下一段";
  assert.equal(stableStreamPrefix(text), "~~~py\nx = 1\n~~~~\n\n");
}

// An open $$ display-math block freezes the boundary until it closes.
{
  const open = "前文\n\n$$\na+b\n\n还在这公式里\n";
  assert.equal(stableStreamPrefix(open), "前文\n\n");
  const closed = "前文\n\n$$\na+b\n$$\n\n后续";
  assert.equal(stableStreamPrefix(closed), "前文\n\n$$\na+b\n$$\n\n");
}

// $$ pairs on one line (or inline $$x$$) do not freeze anything.
{
  const text = "公式 $$a+b$$ 行内\n\n后续";
  assert.equal(stableStreamPrefix(text), "公式 $$a+b$$ 行内\n\n");
}

// --- renderStreamBlocks: prefix caching ---

function spyParse() {
  const calls = [];
  const parse = (md) => {
    calls.push(md);
    return `<p>${md}</p>`;
  };
  return { calls, parse };
}

// First render parses prefix+tail; a longer text with the same stable prefix
// reuses the cached prefix HTML and parses only the new tail.
{
  const cache = new WeakMap();
  const el = {};
  const { calls, parse } = spyParse();
  const v1 = "稳定段落\n\n尾部在";
  assert.equal(renderStreamBlocks(cache, el, v1, parse), "<p>稳定段落\n\n</p><p>尾部在</p>");
  assert.deepEqual(calls, ["稳定段落\n\n", "尾部在"]);

  calls.length = 0;
  const v2 = "稳定段落\n\n尾部在继续生长";
  assert.equal(renderStreamBlocks(cache, el, v2, parse), "<p>稳定段落\n\n</p><p>尾部在继续生长</p>");
  assert.deepEqual(calls, ["尾部在继续生长"], "prefix served from cache, only tail parsed");
}

// A changed prefix invalidates naturally (exact-string key), never stale HTML.
{
  const cache = new WeakMap();
  const el = {};
  const { calls, parse } = spyParse();
  renderStreamBlocks(cache, el, "旧前缀\n\n尾", parse);
  calls.length = 0;
  const out = renderStreamBlocks(cache, el, "新前缀\n\n尾", parse);
  assert.equal(out, "<p>新前缀\n\n</p><p>尾</p>");
  assert.deepEqual(calls, ["新前缀\n\n", "尾"]);
}

// No stable boundary → single whole-text parse, identical to the old path.
{
  const cache = new WeakMap();
  const { calls, parse } = spyParse();
  assert.equal(renderStreamBlocks(cache, {}, "没有空行的流式文本", parse), "<p>没有空行的流式文本</p>");
  assert.deepEqual(calls, ["没有空行的流式文本"]);
}

// Cache is per element: two streaming bubbles never share prefixes.
{
  const cache = new WeakMap();
  const { calls, parse } = spyParse();
  renderStreamBlocks(cache, {}, "段落\n\n尾", parse);
  calls.length = 0;
  renderStreamBlocks(cache, {}, "段落\n\n尾", parse);
  assert.deepEqual(calls, ["段落\n\n", "尾"], "different element = cold cache");
}

console.log("markdown-stream-blocks: ok");
