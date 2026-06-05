#!/usr/bin/env node

const { summarizeTurnProcess, processDetailCounts } = await import("../src/renderer/modules/process-summary.js");

const liveTurn = {
  startedAt: 1000,
  tools: new Map([
    ["read_1", { name: "Read", input: { file_path: "a.js" } }],
    ["read_2", { name: "Read", input: { file_path: "b.js" } }],
    ["grep_1", { name: "Grep", input: { pattern: "foo" } }],
    ["glob_1", { name: "Glob", input: { pattern: "*.js" } }],
    ["bash_1", { name: "Bash", input: { command: "npm test" } }],
  ]),
  notices: [{ type: "engine.notice" }],
};

const summary = summarizeTurnProcess(liveTurn, 15000);
if (summary !== "Thought for 14s, searched for 2 patterns, read 2 files, ran 1 command") {
  throw new Error(`unexpected process summary: ${summary}`);
}

const quiet = summarizeTurnProcess({ startedAt: 1000, tools: new Map(), notices: [] }, 15000);
if (quiet !== "Thought for 14s") {
  throw new Error(`quiet process summary should show thought duration: ${quiet}`);
}

const counts = processDetailCounts(liveTurn);
if (counts.tools !== 5 || counts.notices !== 1) {
  throw new Error(`unexpected process counts: ${JSON.stringify(counts)}`);
}

console.log("process-summary: ok");
