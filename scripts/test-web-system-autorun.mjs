#!/usr/bin/env node
// Autonomous-run safety controller: the guardrails that let the agent drive a
// site ITSELF (no human recording) without running off the rails. Pure logic —
// no browser/LLM. These tests encode WHY each guard exists (AGENTS.md Rule 9/13):
// a write must not slip through in read-only mode, navigation must stay on the
// allowlist, destructive actions must be confirmed, and a run must always be
// able to terminate (step cap + no-progress bound).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts");
const { classifyRisk, domainAllowed, validateAction, progressSignature, shouldStop, isComplete } = require(path.join(SKILL, "autorun_controller.cjs"));

// --- risk classification -------------------------------------------------------
assert.equal(classifyRisk({ type: "click", label: "下一页" }), "read", "plain navigation click is a read");
assert.equal(classifyRisk({ type: "click", label: "保存设置" }), "write", "a click on 保存 is a write, not a read");
assert.equal(classifyRisk({ type: "fill", label: "搜索框" }), "write", "fill is a write");
assert.equal(classifyRisk({ type: "click", label: "删除账户" }), "destructive", "删除 is destructive even via click");
assert.equal(classifyRisk({ type: "frobnicate" }), "write", "unknown action types are treated as writes (conservative)");

// --- domain allowlist ----------------------------------------------------------
assert.ok(domainAllowed("https://app.example.com/x", ["example.com"]), "subdomain of an allowed domain is allowed");
assert.ok(!domainAllowed("https://evil.com/x", ["example.com"]), "off-allowlist host is blocked");
assert.ok(!domainAllowed("https://notexample.com/x", ["example.com"]), "suffix-spoofing host is blocked");

// --- validateAction: the core gate --------------------------------------------
// read-only mode: reads pass, writes are refused.
assert.ok(validateAction({ type: "click", label: "查看详情" }, { mode: "read-only", allowedDomains: ["x.com"] }).ok, "read passes in read-only");
let v = validateAction({ type: "click", label: "提交订单" }, { mode: "read-only", allowedDomains: ["x.com"] });
assert.ok(!v.ok && v.reason === "write-blocked-in-read-only", "write is blocked in read-only mode");

// off-allowlist navigation blocked regardless of mode.
v = validateAction({ type: "navigate", url: "https://evil.com" }, { mode: "authorized", allowedDomains: ["x.com"] });
assert.ok(!v.ok && v.reason === "off-allowlist-navigation", "off-allowlist navigation blocked even when authorized");

// dry-run: a fill is allowed, but the final submit is held back.
assert.ok(validateAction({ type: "fill", label: "数量", value: "2" }, { mode: "dry-run", allowedDomains: ["x.com"] }).ok, "dry-run permits filling fields");
v = validateAction({ type: "click", label: "提交" }, { mode: "dry-run", allowedDomains: ["x.com"] });
assert.ok(!v.ok && v.reason === "submit-blocked-in-dry-run", "dry-run stops before the actual submit");

// authorized: writes pass, but destructive still needs confirmation.
assert.ok(validateAction({ type: "click", label: "保存" }, { mode: "authorized", allowedDomains: ["x.com"] }).ok, "authorized permits writes");
v = validateAction({ type: "click", label: "删除账户", id: "del1" }, { mode: "authorized", allowedDomains: ["x.com"] });
assert.ok(!v.ok && v.needsConfirmation && v.reason === "destructive-needs-confirmation", "destructive needs confirmation even when authorized");
assert.ok(validateAction({ type: "click", label: "删除账户", id: "del1" }, { mode: "authorized", allowedDomains: ["x.com"], confirmed: new Set(["del1"]) }).ok, "destructive proceeds once confirmed");

// --- termination: a run must always be able to stop ----------------------------
assert.deepEqual(shouldStop({ completed: true }), { stop: true, reason: "done" }, "completion stops the run");
assert.equal(shouldStop({ steps: 40, maxSteps: 40 }).reason, "step-cap", "hard step cap stops the run");
const stuck = { steps: 10, maxSteps: 40, maxNoProgress: 4, sigHistory: ["a", "a", "a", "a"] };
assert.equal(shouldStop(stuck).reason, "no-progress", "no-progress bound stops a run spinning on one page");
assert.equal(shouldStop({ steps: 3, maxSteps: 40, sigHistory: ["a", "b", "a"] }).stop, false, "genuine progress keeps going");

assert.notEqual(progressSignature({ url: "https://x.com/a", title: "A" }), progressSignature({ url: "https://x.com/b", title: "B" }), "different pages have different signatures");
assert.equal(progressSignature({ url: "https://x.com/a?q=1", title: "A" }), progressSignature({ url: "https://x.com/a?q=2", title: "A" }), "query-only changes are not progress (same path+title)");

// --- completion backstop -------------------------------------------------------
assert.ok(isComplete({ feedback: { success: "已提交" } }), "explicit success feedback completes");
assert.ok(isComplete({ text: "已列出最优住宿选项" }, ["列出最优住宿选项"]), "a completion-criteria keyword in the page completes");
assert.ok(!isComplete({ text: "still loading" }, ["列出最优住宿选项"]), "absent criteria does not complete");

// --- orchestrator pure helpers (decision parsing / grounding) ------------------
const { parseDecision, decisionToAction } = require(path.join(SKILL, "autorun_web_task.cjs"));
const candidates = [
  { i: 0, tag: "input", type: "text", name: "地点", isPassword: false },
  { i: 1, tag: "input", type: "password", name: "密码", isPassword: true },
  { i: 2, tag: "button", type: "", name: "搜索", isPassword: false },
];

assert.deepEqual(parseDecision('noise {"index": 2, "kind": "click", "reason": "go"} trailing'), { index: 2, kind: "click", reason: "go" }, "decision JSON is extracted from surrounding text");
assert.equal(parseDecision("not json at all"), null, "non-JSON decision returns null (run stops, no improvising)");

assert.equal(decisionToAction({ done: true, reason: "found it" }, candidates).type, "done", "done decision maps to a done action");
assert.equal(decisionToAction({ index: 0, kind: "fill", value: "东京" }, candidates).type, "fill", "fill decision maps to a fill action");
assert.equal(decisionToAction({ index: 1, kind: "fill", value: "secret" }, candidates).type, "blocked-password", "a password field is refused — credentials never come from the model");
assert.equal(decisionToAction({ index: 99 }, candidates), null, "an out-of-range index is rejected (no hallucinated targets)");
assert.equal(decisionToAction({ index: 2 }, candidates).type, "click", "a button defaults to click when kind is omitted");

console.log("web-system-autorun: ok");
