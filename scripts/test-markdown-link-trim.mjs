#!/usr/bin/env node
// A bare URL followed by Chinese punctuation swallowed it: the model wrote
// "服务跑在 http://127.0.0.1:5173，88 个工具" and the chat linked
// "http://127.0.0.1:5173，88", an address that does not even parse — clicking it
// went nowhere (2026-09-15 report). GFM's autolink only trims ASCII trailing
// punctuation, so the full-width case is handled here.
// [gate: conversation-render-order]
// Run: node scripts/test-markdown-link-trim.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { trimTrailingCjkPunctuation, trimAutolinkedPunctuation } from "../src/renderer/modules/markdown-link-trim.js";

const require = createRequire(import.meta.url);

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

check("the link stops at full-width punctuation and keeps everything a URL may contain", () => {
  assert.equal(trimTrailingCjkPunctuation("http://127.0.0.1:5173，88"), "http://127.0.0.1:5173");
  assert.throws(() => new URL("http://127.0.0.1:5173，88"), "the untrimmed address is not even parseable");
  assert.equal(new URL(trimTrailingCjkPunctuation("http://127.0.0.1:5173，88")).port, "5173");
  for (const [raw, want] of [
    ["https://a.com/path。", "https://a.com/path"],
    ["https://a.com/path、b", "https://a.com/path"],
    ["https://a.com（备注）", "https://a.com"],
    ["http://localhost:3000；", "http://localhost:3000"],
    ["http://localhost:3000　", "http://localhost:3000"],
  ]) assert.equal(trimTrailingCjkPunctuation(raw), want, raw);
  // Untouched: ASCII punctuation is GFM's job, and a real CJK path must survive.
  for (const keep of [
    "http://127.0.0.1:5173",
    "https://a.com/a?b=1&c=2#frag",
    "https://a.com/路径/文件.html",
    "https://例え.jp/ページ",
    "https://a.com/a,b",
  ]) assert.equal(trimTrailingCjkPunctuation(keep), keep, keep);
  assert.equal(trimTrailingCjkPunctuation("，only"), "，only", "a leading separator is not a URL to trim");
  assert.equal(trimTrailingCjkPunctuation(""), "");
});

check("only a BARE autolink is rewritten, and the swallowed text comes back as text", () => {
  const doc = fakeDocument();
  const root = doc.body;
  const bare = doc.anchor("http://127.0.0.1:5173，88", "http://127.0.0.1:5173，88");
  const labelled = doc.anchor("http://127.0.0.1:5173，88", "打开工具平台");
  const localFile = doc.anchor("/Users/me/a，b.txt", "/Users/me/a，b.txt", "markdown-local-file-link");
  const clean = doc.anchor("http://127.0.0.1:5173", "http://127.0.0.1:5173");
  root.children.push(bare, labelled, localFile, clean);
  trimAutolinkedPunctuation(root);
  assert.equal(bare.getAttribute("href"), "http://127.0.0.1:5173");
  assert.equal(bare.textContent, "http://127.0.0.1:5173");
  assert.deepEqual(bare.afterNodes, ["，88"], "the rest of the sentence is restored as plain text");
  assert.equal(labelled.getAttribute("href"), "http://127.0.0.1:5173，88", "an explicit [label](url) is the author's intent");
  assert.equal(localFile.getAttribute("href"), "/Users/me/a，b.txt", "local file links have their own handler");
  assert.equal(clean.afterNodes.length, 0, "a clean link is not touched");
});

check("it runs before the other link passes, and never throws on odd input", () => {
  const markdown = fs.readFileSync(new URL("../src/renderer/modules/markdown.js", import.meta.url), "utf8");
  const pipeline = markdown.slice(markdown.indexOf("function enhanceRenderedMarkdown"));
  assert.ok(pipeline.indexOf("trimAutolinkedPunctuation") < pipeline.indexOf("autolinkLocalFilePaths"),
    "trim the href before anything reads it");
  trimAutolinkedPunctuation(null);
  trimAutolinkedPunctuation({});
});

check("a malformed address is repaired so the browser can answer, instead of the click being swallowed", () => {
  const { openableCandidates } = require("../src/main/window-links.js");
  // The reported address: neither the raw form nor the encoded one parses, so
  // the longest parseable prefix is what actually opens the tool platform.
  const repaired = openableCandidates("http://127.0.0.1:5173，88");
  assert.equal(repaired[0], "http://127.0.0.1:5173，88", "the address as written is always tried first");
  assert.ok(repaired.includes("http://127.0.0.1:5173"), "…then the longest parseable prefix");
  assert.equal(new URL(repaired.at(-1)).port, "5173");
  // A valid address is never rewritten.
  for (const good of ["http://127.0.0.1:5173", "https://a.com/路径", "mailto:a@b.com"]) {
    assert.deepEqual(openableCandidates(good), [good], good);
  }
  assert.deepEqual(openableCandidates(""), []);
  const links = fs.readFileSync(new URL("../src/main/window-links.js", import.meta.url), "utf8");
  assert.match(links, /handing it to the OS as-is/, "an unparseable address still gets one last attempt");
});

console.log(`\n${checks} checks passed (markdown link trim)`);

function fakeDocument() {
  const ownerDocument = { createTextNode: (text) => ({ text }) };
  const body = { children: [], ownerDocument, querySelectorAll: (sel) => (sel === "a[href]" ? body.children : []) };
  return {
    body,
    anchor(href, text, className = "") {
      const attrs = { href };
      return {
        textContent: text,
        classList: { contains: (name) => name === className },
        afterNodes: [],
        getAttribute: (name) => attrs[name],
        setAttribute: (name, value) => { attrs[name] = value; },
        after(node) { this.afterNodes.push(node.text); },
      };
    },
  };
}
