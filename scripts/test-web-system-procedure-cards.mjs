#!/usr/bin/env node
// Procedure-card distillation + skill-graph reconciliation (the UI-layer,
// BrowserBC-style half of web-system learning). Pure logic — no browser/LLM.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts");
const { distillProcedureCard, stripLeakage, VALUE_PLACEHOLDER } = require(path.join(SKILL, "distill_procedure_card.cjs"));
const { emptyGraph, mergeCardIntoGraph, retrieveCards } = require(path.join(SKILL, "procedure_graph.cjs"));

// --- leakage stripping ---------------------------------------------------------
const dirty = '#dest .row [data-id="5"] eyJhbGciOiJ.payload.sig 3f6a9b2c1d4e5f6a7b8c9d0e user@example.com at (120, 40)';
const cleaned = stripLeakage(dirty);
for (const bad of ["#dest", ".row", "[data-id=", "eyJhbGci", "3f6a9b2c1d4e5f6a7b8c9d0e", "user@example.com", "(120, 40)"]) {
  assert.ok(!cleaned.includes(bad), `leakage not stripped: ${bad} → "${cleaned}"`);
}

// --- distillation --------------------------------------------------------------
const trajectory = {
  instruction: "在预订网站找到评分最高的民宿（联系 user@example.com，入口 #search-box）",
  steps: [
    { observation: { url: "https://x/搜索", title: "搜索页" }, action: { type: "goto" } },
    { observation: {}, action: { type: "fill", label: "开始日期", value: "2026-07-01" } },
    { observation: {}, action: { type: "fill", label: "地点", value: "东京", locators: { css: "#dest", text: "目的地" } } },
    { observation: {}, action: { type: "click", label: "搜索按钮 at (120, 40)" } },
    { observation: {}, action: { type: "click", label: "应用筛选" }, feedback: { validation: "请先选择日期", error: "token eyJhbGciOi.aaa.bbb expired" } },
    { observation: {}, action: { type: "click", label: "按评分排序" }, feedback: { success: "显示了排序结果" } },
  ],
  finalState: { success: true, signal: "列出最优住宿选项" },
};
const card = distillProcedureCard(trajectory);
const serialized = JSON.stringify(card);

assert.ok(!serialized.includes("#search-box") && !serialized.includes("user@example.com"), "intent leakage must be stripped");
assert.ok(!serialized.includes("eyJhbGci"), "token in feedback must be redacted");
assert.equal(card.steps.length, 6, "one step per recorded action");
assert.ok(card.steps.some((s) => s.action === "fill" && s.note.includes(VALUE_PLACEHOLDER)), "fill values become a task-provided placeholder, not the literal value");
assert.ok(card.steps.every((s) => !/at \(\d/.test(s.target)), "coordinates stripped from targets");
const clickTarget = card.steps.find((s) => s.target.includes("搜索按钮"));
assert.ok(clickTarget && !clickTarget.target.includes("("), "semantic target keeps the label, drops the coords");
assert.ok(card.pitfalls.some((p) => p.includes("请先选择日期")), "validation message captured as a pitfall");
assert.ok(card.recovery.length >= 1, "an error yields a recovery hint");
assert.ok(card.completionCriteria.some((c) => c.includes("列出最优住宿选项")), "final signal is a completion criterion");
assert.equal(card.provenance.success, true);

// --- skill graph: add / merge / specialize / alternative -----------------------
let g = emptyGraph();
const base = { schemaVersion: 1, id: "book-stay", intent: "book a stay", preconditions: ["pre1"], steps: [{ action: "fill" }, { action: "click" }], completionCriteria: ["c1"], pitfalls: ["p1"], recovery: [], provenance: { source: "demonstration", runs: 1, success: true } };

let r = mergeCardIntoGraph(g, base); g = r.graph;
assert.equal(r.action, "add", "new intent is added");

// same intent + same step sequence → merge (runs accumulate, pitfalls union)
r = mergeCardIntoGraph(g, { ...base, pitfalls: ["p2"], provenance: { runs: 1, success: false } }); g = r.graph;
assert.equal(r.action, "merge");
const merged = g.nodes.find((n) => n.id === r.nodeId).card;
assert.equal(merged.provenance.runs, 2, "merge accumulates runs");
assert.deepEqual(merged.pitfalls.sort(), ["p1", "p2"], "merge unions pitfalls");
assert.equal(merged.provenance.success, true, "success stays sticky across a later failure run");

// same intent, strict superset of steps → specialize (child node + edge)
r = mergeCardIntoGraph(g, { ...base, id: "book-stay-filtered", steps: [{ action: "fill" }, { action: "click" }, { action: "select" }] }); g = r.graph;
assert.equal(r.action, "specialize");
assert.ok(g.edges.some((e) => e.kind === "specialize" && e.to === r.nodeId), "specialization edge added");

// same intent, different path → alternative
r = mergeCardIntoGraph(g, { ...base, id: "book-stay-alt", steps: [{ action: "click" }, { action: "fill" }] }); g = r.graph;
assert.equal(r.action, "alternative");

// different intent → add
r = mergeCardIntoGraph(g, { ...base, id: "cancel-booking", intent: "cancel a booking", steps: [{ action: "click" }] }); g = r.graph;
assert.equal(r.action, "add");

// --- retrieval -----------------------------------------------------------------
const hits = retrieveCards(g, "book a stay");
assert.ok(hits.length >= 1 && hits.every((c) => c.intent.includes("book")), "retrieval ranks the booking cards");
assert.ok(!retrieveCards(g, "completely unrelated zzz").length, "no spurious hits");

console.log("web-system-procedure-cards: ok");
