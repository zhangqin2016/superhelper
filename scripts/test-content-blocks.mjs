#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs
  .readFileSync(new URL("../src/renderer/modules/content-blocks.js", import.meta.url), "utf8")
  .replace('import { renderMarkdownWithCache, renderStreamingMarkdown } from "./markdown.js";', "")
  .replace('import { isMermaidLanguage, looksLikeMermaidCode, normalizeCodeLanguage } from "./mermaid-detect.js";', "")
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
  MERMAID_START_RE,
  MERMAID_LANGUAGES,
  normalizeCodeLanguage(lang = "") {
    return String(lang || "").trim().split(/\s+/)[0];
  },
  looksLikeMermaidCode(source = "") {
    const firstLine = String(source).split("\n").map((line) => line.trim()).find(Boolean) || "";
    return MERMAID_START_RE.test(firstLine);
  },
  isMermaidLanguage(lang = "") {
    return MERMAID_LANGUAGES.has(String(lang || "").trim().split(/\s+/)[0]);
  },
  renderMarkdownWithCache() {},
  renderStreamingMarkdown() {},
  window: {},
};
vm.createContext(context);
vm.runInContext(`${source}\nwindow.__test = { markdownToContentBlocks };`, context);

const fencedPie = context.window.__test.markdownToContentBlocks(
  "地点分布\n\n```pie\npie showData\n    title 事件发生地点分布\n    \"Abu Dhabi\" : 8\n```\n\n后续说明",
);
assert.equal(fencedPie.length, 3);
assert.equal(fencedPie[0].type, "markdown");
assert.equal(fencedPie[1].type, "artifact");
assert.equal(fencedPie[1].artifactType, "chart");
assert.equal(fencedPie[1].chartType, "mermaid");
assert.match(fencedPie[1].source, /^pie showData/);
assert.equal(fencedPie[2].type, "markdown");

const indentedPie = context.window.__test.markdownToContentBlocks(
  "地点分布\n\n    pie showData\n        title 事件发生地点分布\n        \"Dubai\" : 8\n\n| 城市 | 数量 |\n| --- | --- |\n| Dubai | 8 |",
);
assert.equal(indentedPie.length, 3);
assert.equal(indentedPie[1].type, "artifact");
assert.equal(indentedPie[1].sourceFormat, "indented-mermaid");
assert.match(indentedPie[1].source, /"Dubai" : 8/);
assert.match(indentedPie[2].text, /城市/);

const normalCode = context.window.__test.markdownToContentBlocks(
  "代码\n\n    const x = 1;\n    console.log(x);\n",
);
assert.equal(normalCode.length, 1);
assert.equal(normalCode[0].type, "markdown");
assert.match(normalCode[0].text, /const x = 1/);

const fencedGraph = context.window.__test.markdownToContentBlocks(
  "```mermaid\ngraph TD\nA-->B\n```",
);
assert.equal(fencedGraph.length, 1);
assert.equal(fencedGraph[0].type, "artifact");
assert.match(fencedGraph[0].source, /A-->B/);

console.log("content-blocks: ok");
