#!/usr/bin/env node
"use strict";

/**
 * Distill a recorded human demonstration trajectory into a reusable, transferable
 * "procedure card" — the BrowserBC-style natural-language skill, the UI-layer
 * counterpart to our API contracts.
 *
 * Hard rule (BrowserBC's leakage check, and our security stance): keep only
 * TRANSFERABLE PROCESSUAL knowledge — what to do, how to tell progress, when it's
 * done, how it fails — and STRIP everything brittle or sensitive: pixel
 * coordinates, CSS/DOM selectors, transient ids/uuids, tokens, login state, PII,
 * and concrete answer values (replaced with a "from the task" placeholder). The
 * card is meant to be read by ANOTHER model that grounds it on the live page —
 * never replayed as fixed coordinates.
 *
 * Pure + unit-testable (no DOM/network/LLM). The browser recorder
 * (record_demonstration.cjs) produces the trajectory; this turns it into a card;
 * procedure_graph.cjs organizes many cards. Verified by
 * scripts/test-web-system-procedure-cards.mjs.
 *
 * Trajectory shape (what the recorder emits):
 *   { instruction, steps: [{ observation:{url,title,a11ySummary?},
 *       action:{type,label?,role?,value?,locators?}, feedback?:{navigatedTo?,error?,validation?,success?} }],
 *     finalState:{url?,success?,signal?} }
 */

const VALUE_PLACEHOLDER = "<task-provided>";

// Patterns we redact wherever free text might carry brittle/sensitive detail.
const LEAK_PATTERNS = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"], // uuid
  [/\b[0-9a-f]{24,}\b/gi, "<id>"], // long hex id / mongo id / token-ish
  [/\b(?:eyJ[A-Za-z0-9._-]{10,})\b/g, "<token>"], // JWT-ish
  [/\bBearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <token>"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>"], // email PII
  [/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, "<phone>"], // phone-ish PII
  [/\bat\s*\(?\d{2,4}\s*,\s*\d{2,4}\)?/gi, ""], // pixel coords "at (x, y)"
  [/[#.][A-Za-z_][\w-]*(?:\s*[>+~]\s*[#.][A-Za-z_][\w-]*)*/g, ""], // css selectors
  [/\[[A-Za-z-]+=["'][^"']*["']\]/g, ""], // [attr="..."] selectors
];

function stripLeakage(text) {
  let out = String(text || "");
  for (const [re, repl] of LEAK_PATTERNS) out = out.replace(re, repl);
  return out.replace(/\s{2,}/g, " ").trim();
}

function clamp(text, max = 120) {
  const s = stripLeakage(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// A step's target is its SEMANTIC anchor (role/label/placeholder/text), never a
// selector or coordinate. The recorder may hand us several; pick the most
// human-meaningful and strip the rest.
function semanticTarget(action) {
  const label = stripLeakage(action?.label || action?.role || action?.locators?.text || "");
  return label || "the relevant control";
}

function stepFromAction(action, index) {
  const type = String(action?.type || "").toLowerCase();
  const target = semanticTarget(action);
  // Concrete input values are task-specific, not part of the reusable procedure.
  const valued = action?.value != null && String(action.value).trim() !== "";
  switch (type) {
    case "fill":
    case "type":
      return { order: index + 1, action: "fill", target, note: valued ? `enter the ${target} value ${VALUE_PLACEHOLDER}` : `fill ${target}` };
    case "select":
      return { order: index + 1, action: "select", target, note: `choose the appropriate ${target}` };
    case "check":
    case "uncheck":
      return { order: index + 1, action: type, target, note: `${type} ${target}` };
    case "click":
    case "submit":
    case "press":
      return { order: index + 1, action: type, target, note: `${type === "submit" ? "submit via" : type} ${target}` };
    case "goto":
      return { order: index + 1, action: "navigate", target: "the target page", note: "open the relevant page" };
    default:
      return { order: index + 1, action: type || "act", target, note: clamp(`${type} ${target}`) };
  }
}

// Completion criteria: prefer explicit success signals; otherwise describe the
// terminal observation in semantic terms.
function completionCriteria(trajectory) {
  const out = [];
  const fs = trajectory.finalState || {};
  if (fs.signal) out.push(clamp(fs.signal));
  const lastFeedback = [...(trajectory.steps || [])].reverse().find((s) => s?.feedback?.success);
  if (lastFeedback?.feedback?.success) out.push(clamp(String(lastFeedback.feedback.success)));
  if (!out.length) out.push("the page confirms the action succeeded (success state / expected result visible)");
  return [...new Set(out)];
}

// Pitfalls + recovery come from the steps that hit validation/errors — exactly
// what makes a card robust (BrowserBC: failed runs expose missing preconditions).
function pitfallsAndRecovery(trajectory) {
  const pitfalls = [];
  const recovery = [];
  for (const step of trajectory.steps || []) {
    const fb = step?.feedback || {};
    if (fb.validation) pitfalls.push(clamp(`validation: ${fb.validation}`));
    if (fb.error) {
      pitfalls.push(clamp(`error: ${fb.error}`));
      recovery.push(clamp(`if "${fb.error}" appears, re-check the preceding ${semanticTarget(step.action)} and retry`));
    }
  }
  return { pitfalls: [...new Set(pitfalls)], recovery: [...new Set(recovery)] };
}

function preconditions(trajectory) {
  const out = ["an authenticated session for the system (log in if redirected to a sign-in page)"];
  const firstNav = (trajectory.steps || []).find((s) => s?.action?.type === "goto" || s?.observation?.url);
  if (firstNav?.observation?.title) out.push(clamp(`start from: ${firstNav.observation.title}`));
  return out;
}

function slugify(text) {
  return stripLeakage(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "procedure";
}

/** Distill one trajectory → one procedure card. */
function distillProcedureCard(trajectory = {}, opts = {}) {
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const intent = clamp(trajectory.instruction || opts.intent || "complete the task");
  const success = Boolean(trajectory.finalState?.success ?? opts.success);
  const { pitfalls, recovery } = pitfallsAndRecovery(trajectory);
  return {
    schemaVersion: 1,
    id: opts.id || slugify(intent),
    intent,
    preconditions: preconditions(trajectory),
    steps: steps
      .filter((s) => s && s.action && s.action.type)
      .map((s, i) => stepFromAction(s.action, i)),
    completionCriteria: completionCriteria(trajectory),
    pitfalls,
    recovery,
    provenance: { source: "demonstration", runs: 1, success },
  };
}

module.exports = { distillProcedureCard, stripLeakage, VALUE_PLACEHOLDER };

// CLI: read a trajectory JSON from --in (or stdin), write the card to --out (or stdout).
if (require.main === module) {
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ""; };
  const inPath = get("--in");
  const outPath = get("--out");
  const raw = inPath ? fs.readFileSync(inPath, "utf8") : fs.readFileSync(0, "utf8");
  const card = distillProcedureCard(JSON.parse(raw || "{}"));
  const json = `${JSON.stringify(card, null, 2)}\n`;
  if (outPath) { fs.writeFileSync(outPath, json); process.stderr.write(`[distill] wrote ${outPath}\n`); }
  else process.stdout.write(json);
}
