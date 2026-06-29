#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

function parseToolText(result) {
  const text = result?.content?.find?.((item) => item.type === "text")?.text || "";
  return JSON.parse(text);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-file-intel-mcp-"));
const sample = path.join(tmp, "sample.log");
fs.writeFileSync(sample, "one\ntwo\nthree\nfour\n");

const client = new Client({ name: "file-intelligence-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), "src/main/mcp/file-intelligence-mcp-stdio.js")],
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(
    names,
    ["extract_file_range", "index_path", "inspect_file", "query_index", "sample_file"],
    "stdio server exposes file intelligence tools",
  );

  const inspected = parseToolText(await client.callTool({
    name: "inspect_file",
    arguments: { path: sample },
  }));
  assert.equal(inspected.ok, true, "inspect_file returns ok JSON");
  assert.equal(inspected.kind, "text", "inspect_file detects text");
  assert(!("text" in inspected), "inspect_file does not return full content");

  const sampled = parseToolText(await client.callTool({
    name: "sample_file",
    arguments: { path: sample, strategy: "tail", lines: 2 },
  }));
  assert.equal(sampled.coverage, "sampled", "sample_file marks sampled coverage");
  assert.match(sampled.text, /three/, "sample_file returns requested tail lines");
  assert.match(sampled.text, /four/, "sample_file returns requested tail lines");

  const extracted = parseToolText(await client.callTool({
    name: "extract_file_range",
    arguments: { path: sample, range: { type: "lines", start: 2, end: 3 } },
  }));
  assert.equal(extracted.coverage, "partial", "extract_file_range marks partial coverage");
  assert.equal(extracted.rangeStart, 2);
  assert.equal(extracted.rangeEnd, 3);
  assert.equal(extracted.text, "two\nthree");

  const indexed = parseToolText(await client.callTool({
    name: "index_path",
    arguments: { path: sample, chunkLineCount: 2 },
  }));
  assert.equal(indexed.ok, true, "index_path builds an index");
  assert.equal(indexed.coverage, "indexed", "index_path marks indexed coverage");
  assert(indexed.indexId, "index_path returns an index id");

  const queried = parseToolText(await client.callTool({
    name: "query_index",
    arguments: { indexId: indexed.indexId, query: "three", limit: 2 },
  }));
  assert.equal(queried.ok, true, "query_index returns ok JSON");
  assert.equal(queried.coverage, "indexed", "query_index keeps indexed coverage");
  assert.equal(queried.matches.length, 1, "query_index returns matching evidence");
  assert.equal(queried.matches[0].rangeType, "lines", "query evidence carries line ranges");
  assert.match(queried.matches[0].excerpt, /three/, "query evidence contains compact excerpt");

  console.log("file-intelligence-mcp: ok");
} finally {
  await client.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
