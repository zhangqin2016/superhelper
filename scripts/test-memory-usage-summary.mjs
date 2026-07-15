#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { summarizeMemoryUsage } = require("../src/main/memory-usage-summary.js");

// fail-open / empty cases → null (UI shows nothing, never throws)
assert.equal(summarizeMemoryUsage(null), null, "null → null");
assert.equal(summarizeMemoryUsage({}), null, "no injected → null");
assert.equal(summarizeMemoryUsage({ injected: true, items: [] }), null, "injected but no items → null");
assert.equal(summarizeMemoryUsage({ injected: false, items: [{ kind: "x" }] }), null, "not injected → null");

// semantic-mode summary with session + workspace scoped items
const semantic = summarizeMemoryUsage({
  injected: true,
  diagnostics: { semanticIndex: "embedding" },
  items: [
    { kind: "session_summary", reason: "continuity", trust: "lily_session_memory", relevance: 0.4, semanticRelevance: 0.8 },
    { kind: "project_memory", reason: "curated workspace memory index", relevance: 0.3, semanticRelevance: 0.7, sourcePointers: [{ filePath: "/repo/lily/memory/MEMORY.md" }] },
    { kind: "learned_conventions", reason: "user learned", sourcePointers: [{ turnId: "t1" }] },
  ],
});
assert.equal(semantic.used, true);
assert.equal(semantic.count, 3);
assert.equal(semantic.mode, "semantic", "embedding diagnostics → semantic mode");
assert.equal(semantic.scopes.session, 1, "session_summary is session-scoped");
assert.equal(semantic.scopes.workspace, 2, "project_memory + learned_conventions are workspace-scoped");
assert.equal(semantic.items[0].label, "会话摘要");
assert.equal(semantic.items[1].label, "工作区记忆");
assert.equal(semantic.items[1].source, "MEMORY.md", "file source shows basename");
assert.equal(semantic.items[2].source, "本会话较早的对话", "turn pointer source label");

// lexical mode when no embedding diagnostics
const lexical = summarizeMemoryUsage({
  injected: true,
  diagnostics: { semanticIndex: "durable" },
  items: [{ kind: "project_memory", reason: "x" }],
});
assert.equal(lexical.mode, "lexical", "durable diagnostics → lexical mode");

// bounded: many items capped + truncated flag + long reason clamped
const many = summarizeMemoryUsage({
  injected: true,
  diagnostics: { semanticIndex: "embedding" },
  items: Array.from({ length: 20 }, (_, i) => ({ kind: "project_memory", reason: "r".repeat(200) + i })),
});
assert.equal(many.count, 20, "count reflects all items");
assert.ok(many.items.length <= 12, "items capped at 12");
assert.equal(many.truncated, true, "truncated flag set when capped");
assert.ok(many.items[0].reason.length <= 80, "reason clamped");

// unknown kind falls back gracefully (workspace scope, kind as label)
const unknown = summarizeMemoryUsage({ injected: true, items: [{ kind: "mystery_kind", reason: "r" }] });
assert.equal(unknown.items[0].label, "mystery_kind");
assert.equal(unknown.items[0].scope, "workspace");

console.log("memory-usage-summary: ok");
