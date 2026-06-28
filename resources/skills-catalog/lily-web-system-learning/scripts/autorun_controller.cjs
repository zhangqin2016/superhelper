#!/usr/bin/env node
"use strict";

/**
 * Safety controller for AUTONOMOUS web-task runs — the agent drives the site
 * itself (no human recording) to learn a flow, then we distill its successful
 * trajectory into a procedure card. This module is the pure, unit-testable
 * "should I take this action / should I stop" core; the browser + model loop
 * (autorun_web_task.cjs) wraps it.
 *
 * It encodes the non-negotiable guardrails (CLAUDE.md Rule 13 / CAPABILITY-GATE):
 *   - domain allowlist (no off-site navigation / SSRF),
 *   - READ-ONLY by default — writes only in an explicitly authorized mode, and
 *     destructive actions ALWAYS need confirmation,
 *   - bounded effort: a hard step cap AND a no-progress bound so the run can never
 *     spin forever (bound non-progress, not just effort),
 *   - never silently improvise past a structured failure → stop with a reason.
 *
 * No DOM/network/LLM here. Verified by scripts/test-web-system-autorun.mjs.
 */

const WRITE_ACTION_TYPES = new Set(["fill", "type", "select", "check", "uncheck", "upload", "submit", "press"]);
const READ_ACTION_TYPES = new Set(["click", "navigate", "goto", "wait", "extract", "read", "scroll", "done"]);
const DESTRUCTIVE_RE = /(删除|移除|清空|注销|停用|作废|退款|delete|remove|destroy|deactivate|cancel|wipe|purge)/i;
const WRITE_RE = /(提交|保存|确认|支付|付款|下单|创建|新建|更新|发送|submit|save|confirm|pay|checkout|create|update|send|apply)/i;

function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return "";
  }
}

function domainAllowed(url, allowedDomains = []) {
  const host = hostOf(url);
  if (!host) return false; // relative/in-page actions are validated by the caller, not here
  return (allowedDomains || []).some((d) => {
    const dom = String(d || "").toLowerCase().replace(/^\*\.?/, "");
    return host === dom || host.endsWith(`.${dom}`);
  });
}

/** read | write | destructive — by action type, then by the target/label wording
 *  (a "click" on 删除/支付 is a write/destructive, not a safe read). */
function classifyRisk(action = {}) {
  const type = String(action.type || "").toLowerCase();
  const text = `${action.label || ""} ${action.target || ""} ${action.value || ""}`;
  if (DESTRUCTIVE_RE.test(text)) return "destructive";
  if (WRITE_ACTION_TYPES.has(type)) return DESTRUCTIVE_RE.test(text) ? "destructive" : "write";
  if (type === "click" && WRITE_RE.test(text)) return DESTRUCTIVE_RE.test(text) ? "destructive" : "write";
  if (READ_ACTION_TYPES.has(type)) return "read";
  return "write"; // unknown action type → treat as a write (conservative)
}

/**
 * Decide whether a proposed action may run.
 * ctx: { mode:"read-only"|"dry-run"|"authorized", allowedDomains:[], confirmed?:Set|fn }
 * Returns { ok, risk, reason, needsConfirmation }.
 */
function validateAction(action = {}, ctx = {}) {
  const mode = ctx.mode || "read-only";
  const risk = classifyRisk(action);

  // Off-allowlist navigation is always blocked (SSRF / scope creep).
  const navUrl = action.type === "navigate" || action.type === "goto" ? action.url || action.target : "";
  if (navUrl && !domainAllowed(navUrl, ctx.allowedDomains)) {
    return { ok: false, risk, reason: "off-allowlist-navigation", needsConfirmation: false };
  }

  if (risk === "read") return { ok: true, risk, reason: "read", needsConfirmation: false };

  // Writes: only in dry-run (fills allowed, stop before submit) or authorized.
  if (mode === "read-only") return { ok: false, risk, reason: "write-blocked-in-read-only", needsConfirmation: false };
  if (mode === "dry-run" && (risk === "write" || risk === "destructive") && /submit|press|提交|确认|支付|保存|send|create|update/i.test(`${action.type} ${action.label} ${action.target}`)) {
    return { ok: false, risk, reason: "submit-blocked-in-dry-run", needsConfirmation: false };
  }

  // Destructive always needs explicit confirmation, even when authorized.
  if (risk === "destructive") {
    const confirmed = typeof ctx.confirmed === "function" ? ctx.confirmed(action) : ctx.confirmed?.has?.(action.id || action.label);
    if (!confirmed) return { ok: false, risk, reason: "destructive-needs-confirmation", needsConfirmation: true };
  }
  return { ok: true, risk, reason: "authorized", needsConfirmation: false };
}

/** A page-identity signature for no-progress detection (URL + title, not actions). */
function progressSignature(observation = {}) {
  return `${hostOf(observation.url)}${(() => { try { return new URL(observation.url).pathname; } catch { return ""; } })()}|${String(observation.title || "").trim()}`;
}

/**
 * Bound the run. state: { steps, maxSteps=40, sigHistory:[], maxNoProgress=4,
 * completed:false, lastError:false }. Returns { stop, reason }.
 */
function shouldStop(state = {}) {
  if (state.completed) return { stop: true, reason: "done" };
  const maxSteps = Number(state.maxSteps || 40);
  if (Number(state.steps || 0) >= maxSteps) return { stop: true, reason: "step-cap" };
  const maxNoProgress = Number(state.maxNoProgress || 4);
  const sigs = Array.isArray(state.sigHistory) ? state.sigHistory : [];
  if (sigs.length >= maxNoProgress) {
    const tail = sigs.slice(-maxNoProgress);
    if (tail.every((s) => s === tail[0])) return { stop: true, reason: "no-progress" };
  }
  return { stop: false, reason: "" };
}

/** Structural completion check: explicit success feedback, or a completion-criteria
 *  keyword present in the observation. (Semantic judgement is the model's job at
 *  run time; this is the deterministic backstop so a run can always terminate.) */
function isComplete(observation = {}, criteria = []) {
  if (observation.success === true || observation.feedback?.success) return true;
  const hay = `${observation.title || ""} ${observation.text || ""} ${observation.signal || ""}`.toLowerCase();
  return (Array.isArray(criteria) ? criteria : []).some((c) => {
    const key = String(c || "").toLowerCase().slice(0, 16);
    return key.length >= 4 && hay.includes(key);
  });
}

module.exports = { classifyRisk, domainAllowed, validateAction, progressSignature, shouldStop, isComplete };
