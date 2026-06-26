#!/usr/bin/env node
/**
 * Closed-loop verification of cross-session memory injection (#1) WITHOUT the
 * engine: the real Lily exporter writes the handoff file, then the real OpenCode
 * compaction plugin reads it back over the env contract and injects it into the
 * compaction `context`. This proves the two-process handoff end to end.
 *
 * WHY each assertion matters: the plugin runs inside the OpenCode (Bun) serve and
 * sits on the path that just caused summarize-500s — so it MUST fail open. A
 * missing/garbled/oversized/forged input must leave compaction untouched, never
 * throw. And a real input must actually carry the durable facts through.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CompactionMemoryPlugin } from "../resources/opencode-plugins/compaction-memory.js";

const require = createRequire(import.meta.url);
const { writeCompactionMemoryFile } = require("../src/main/compaction-memory-export.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-compact-plugin-"));
process.env.LILY_COMPACTION_MEMORY_DIR = dir;

const hooks = await CompactionMemoryPlugin();
const hook = hooks["experimental.session.compacting"];
assert.equal(typeof hook, "function", "plugin registers the experimental.session.compacting hook");

async function compact(sessionID) {
  const output = { context: [], prompt: undefined };
  await hook({ sessionID }, output);
  return output;
}

// --- the closed loop: exporter writes -> plugin injects ---------------------
writeCompactionMemoryFile(dir, "ses_loop1", {
  pendingTask: "赶超 claude cli",
  lastAssistantResult: "命主生辰=甲子年 SENTINEL-KEEP",
  recentFiles: ["plan.md"],
});
const injected = await compact("ses_loop1");
assert.ok(injected.context.length >= 2, "context is injected");
assert.match(injected.context[0], /持久事实|保留/, "first entry is the preserve directive");
assert.ok(injected.context.some((c) => /SENTINEL-KEEP/.test(c)), "durable fact survives into the compaction context");
assert.equal(injected.prompt, undefined, "engine's own compaction prompt is NOT replaced (low-risk: context only)");

// --- fail open: every bad input leaves compaction untouched -----------------
assert.deepEqual((await compact("ses_missing")).context, [], "no file -> context untouched (engine default)");

fs.writeFileSync(path.join(dir, "ses_bad.json"), "{not json");
assert.deepEqual((await compact("ses_bad")).context, [], "malformed file -> fail open, untouched");

fs.writeFileSync(path.join(dir, "ses_empty.json"), JSON.stringify({ schemaVersion: 1, blocks: [] }));
assert.deepEqual((await compact("ses_empty")).context, [], "empty blocks -> nothing injected");

// Path-traversal / forged session id must never read outside the keyed file.
assert.deepEqual((await compact("../../etc/passwd")).context, [], "unsafe session id rejected");

// Pre-existing context from other plugins is preserved (we prepend, never drop).
writeCompactionMemoryFile(dir, "ses_merge", { pendingTask: "X" });
const merged = { context: ["existing-from-other-plugin"], prompt: undefined };
await hook({ sessionID: "ses_merge" }, merged);
assert.ok(merged.context.includes("existing-from-other-plugin"), "existing context is kept");

// Budget: a flood of large blocks is capped, never re-bloats the freed context.
const huge = Array.from({ length: 50 }, (_, i) => `BLOCK${i}-${"x".repeat(200)}`);
fs.writeFileSync(path.join(dir, "ses_huge.json"), JSON.stringify({ schemaVersion: 1, blocks: huge }));
const capped = await compact("ses_huge");
assert.ok(capped.context.join("").length <= 1800 + 200, "injection stays within the budget ceiling");
assert.ok(capped.context.length < huge.length, "not all oversized blocks are injected");

fs.rmSync(dir, { recursive: true, force: true });
console.log("compaction-memory-plugin: ok");
