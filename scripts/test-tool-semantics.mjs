#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isReplaySafeTool,
  isSideEffectFreeToolRun,
  registerToolSemantics,
  resolveToolSemantics,
} = require("../src/main/tool-semantics");

assert.equal(isReplaySafeTool("read"), true);
assert.equal(isReplaySafeTool("tool.read"), true);
assert.equal(isReplaySafeTool("websearch"), true);
assert.equal(isReplaySafeTool("web_search"), true);
assert.equal(isReplaySafeTool("web_fetch"), true);
assert.equal(isReplaySafeTool("lily_tool_broker_lily_intent_contract_commit"), true);
assert.equal(isReplaySafeTool("write"), false);
assert.equal(isReplaySafeTool("unknown_mcp_tool"), false, "unknown tools must fail closed for replay");
assert.equal(resolveToolSemantics({ name: "bash", input: { command: "git push" } }).destructive, true);
assert.equal(resolveToolSemantics({ name: "bash", input: { command: "rg TODO src" } }).replaySafe, false);
const bundledSearchCommand = String.raw`echo '{"query":"official source"}' | "C:\runtime-bin\node.cmd" "C:\skills\websearch\scripts\websearch.cjs"`;
assert.equal(resolveToolSemantics({ name: "Bash", input: { command: bundledSearchCommand } }).replaySafe, true);
assert.equal(resolveToolSemantics({ name: "Bash", input: { command: bundledSearchCommand } }).evidenceKind, "web_search");
assert.equal(
  resolveToolSemantics({ name: "Bash", input: { command: `${bundledSearchCommand}; git push` } }).replaySafe,
  false,
  "a bundled search mention must not make a chained shell command replay-safe",
);
assert.equal(resolveToolSemantics({ name: "Bash", input: { command: "echo websearch.cjs" } }).replaySafe, false);

registerToolSemantics("lily_read_only_probe", { readOnly: true, externalSideEffect: false });
assert.equal(isReplaySafeTool("mcp.lily_read_only_probe"), true);
assert.equal(isSideEffectFreeToolRun([{ name: "read" }, { name: "webfetch" }]), true);
assert.equal(isSideEffectFreeToolRun([{ name: "read" }, { name: "mail_send" }]), false);

console.log("tool-semantics: ok");
