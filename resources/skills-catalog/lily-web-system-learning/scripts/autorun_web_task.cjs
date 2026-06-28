#!/usr/bin/env node
"use strict";

/**
 * AUTONOMOUS web-task runner — "let the system run it itself" instead of asking a
 * human to record a demonstration. Given a task instruction + a base URL, the
 * agent drives the live site on its own: at each step it observes the page,
 * enumerates the interactive elements, asks the model to pick ONE next action
 * from that menu (constrained vocabulary → grounded + parseable), runs it through
 * the safety controller, executes it, and records what happened. On success it
 * emits a trajectory in the exact shape distill_procedure_card.cjs consumes, so a
 * self-run produces a procedure card with NO human in the loop.
 *
 * Safety is non-negotiable (CLAUDE.md Rule 13 / CAPABILITY-GATE):
 *   - read-only by default; writes only in --mode dry-run/authorized; the
 *     autorun_controller gates every action (allowlist, risk, confirmation).
 *   - bounded: hard step cap + no-progress bound (controller.shouldStop).
 *   - credentials are never typed/logged here: a password field stops the run
 *     with needs-auth (auth comes from a pre-seeded storageState / the Electron
 *     credential vault, never from a prompt, log, or this trajectory).
 *   - degrades to today's behavior: if Playwright or the model is unavailable, it
 *     fails loud with a code and changes nothing.
 *
 * This module is the browser+model SHELL; its decision/guardrail core lives in
 * autorun_controller.cjs (pure, unit-tested by scripts/test-web-system-autorun.mjs).
 * The loop itself needs a live browser + model to verify end-to-end.
 */

const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const { validateAction, progressSignature, shouldStop, isComplete } = require("./autorun_controller.cjs");
const { distillProcedureCard } = require("./distill_procedure_card.cjs");

const VALUE_PLACEHOLDER_NOTE = "<task-provided>"; // never echo real input values into logs

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
  });
}

function emit(payload, code = 0) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

// --- model call (OpenAI-compatible chat/completions, same convention as vision) ---
function modelConfig() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.LILY_MODEL_BASE_URL || "";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
  const model = process.env.LILY_MODEL || process.env.ANTHROPIC_MODEL || "";
  return { baseUrl, apiKey, model };
}

function callModel(cfg, messages, timeoutMs = 60000) {
  const url = new URL(`${cfg.baseUrl.replace(/\/?$/, "/")}chat/completions`);
  const body = JSON.stringify({ model: cfg.model, messages, temperature: 0, max_tokens: 400 });
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`model ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content || ""); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("model timeout")); });
    req.write(body); req.end();
  });
}

// --- observation: enumerate interactive elements as a numbered menu --------------
async function snapshotObservation(page) {
  const title = await page.title().catch(() => "");
  const candidates = await page.$$eval(
    "a[href], button, [role=button], [role=tab], [role=menuitem], input:not([type=hidden]), select, textarea",
    (els) => els.slice(0, 60).map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const name = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || el.value || el.getAttribute("name") || "").trim().slice(0, 80);
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.top < (window.innerHeight + 200);
      return { i, tag, type, name, visible, isPassword: type === "password" };
    }).filter((c) => c.visible && (c.name || c.tag === "select"))
  ).catch(() => []);
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || "").catch(() => "");
  return { url: page.url(), title, candidates, text };
}

function decisionMenu(candidates) {
  return candidates.map((c) => `[${c.i}] <${c.tag}${c.type ? ":" + c.type : ""}> ${c.name || "(no label)"}`).join("\n");
}

function buildMessages(instruction, observation, history) {
  const sys = [
    "You autonomously operate a web app to accomplish a task, one step at a time.",
    "Pick exactly ONE next action from the numbered ELEMENTS menu, or finish.",
    'Reply with ONLY a JSON object: {"index": <n>, "kind": "click|fill|select", "value": "<text if fill/select>", "reason": "<short>"}',
    'or {"done": true, "reason": "..."} when the task is complete on the current page.',
    "Never choose a password field. Prefer the element whose label most matches the task. Do not invent indices.",
  ].join("\n");
  const hist = history.slice(-6).map((h, i) => `${i + 1}. ${h.action.type} "${h.action.label}"${h.feedback?.error ? " → error: " + h.feedback.error : ""}`).join("\n") || "(none yet)";
  const user = [
    `TASK: ${instruction}`,
    `URL: ${observation.url}`,
    `PAGE TITLE: ${observation.title}`,
    `RECENT STEPS:\n${hist}`,
    `ELEMENTS:\n${decisionMenu(observation.candidates)}`,
    `VISIBLE TEXT (excerpt):\n${observation.text.slice(0, 800)}`,
  ].join("\n\n");
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

function parseDecision(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function decisionToAction(decision, candidates) {
  if (decision?.done) return { type: "done", label: "task complete", reason: decision.reason || "" };
  const c = candidates.find((x) => x.i === Number(decision?.index));
  if (!c) return null;
  if (c.isPassword) return { type: "blocked-password", label: c.name };
  const kind = decision.kind || (c.tag === "select" ? "select" : (c.tag === "input" || c.tag === "textarea") ? "fill" : "click");
  return { type: kind, label: c.name, target: c.name, value: decision.value, _candidate: c };
}

async function performAction(page, action) {
  const c = action._candidate;
  // Re-resolve the element by index at execution time (DOM is live).
  const handle = (await page.$$("a[href], button, [role=button], [role=tab], [role=menuitem], input:not([type=hidden]), select, textarea"))[c.i];
  if (!handle) throw new Error("element no longer present");
  if (action.type === "fill") { await handle.fill(String(action.value ?? "")); return; }
  if (action.type === "select") { await handle.selectOption({ label: String(action.value ?? "") }).catch(() => handle.selectOption(String(action.value ?? ""))); return; }
  await handle.click({ timeout: 8000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
}

async function captureFeedback(page) {
  // Surface inline validation / toast / error text so the model can recover and
  // so the distilled card learns the pitfall.
  return page.evaluate(() => {
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.innerText?.trim()).filter(Boolean).join(" | ").slice(0, 200);
    const error = pick('[role=alert], .error, .ant-form-item-explain-error, .el-form-item__error');
    const success = pick('.success, .ant-message-success, [role=status]');
    return { error: error || "", success: success || "" };
  }).catch(() => ({ error: "", success: "" }));
}

async function main() {
  const input = JSON.parse((await readStdin()) || "{}");
  const instruction = String(input.instruction || input.task || "").trim();
  const baseUrl = String(input.baseUrl || input.url || "").trim();
  const mode = input.mode || "read-only";
  const allowedDomains = Array.isArray(input.allowedDomains) ? input.allowedDomains : (baseUrl ? [new URL(baseUrl).host] : []);
  const maxSteps = Number(input.maxSteps || 30);
  const completionCriteria = Array.isArray(input.completionCriteria) ? input.completionCriteria : (instruction ? [instruction] : []);
  const headful = Boolean(input.headful);

  if (!instruction || !baseUrl) emit({ ok: false, code: "BAD_INPUT", message: "instruction and baseUrl are required" }, 2);

  const cfg = modelConfig();
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    emit({ ok: false, code: "MODEL_UNAVAILABLE", message: "No model endpoint configured (ANTHROPIC_BASE_URL / token / LILY_MODEL). Autorun needs an in-loop model." }, 3);
  }

  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch (err) { emit({ ok: false, code: "PLAYWRIGHT_NODE_MISSING", message: "Playwright for Node.js is not installed. Run read-only scan first or install a browser runtime pack.", detail: err.message }, 4); }

  const browser = await chromium.launch({ headless: !headful });
  const contextOptions = {};
  if (input.storageState) contextOptions.storageState = input.storageState; // pre-seeded auth; never a password
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const trajectory = { instruction, steps: [], finalState: { success: false, signal: "" } };
  const sigHistory = [];
  let stopReason = "";

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    trajectory.steps.push({ observation: { url: page.url() }, action: { type: "goto", label: "open start page", target: baseUrl } });

    for (let step = 0; step < maxSteps; step += 1) {
      const observation = await snapshotObservation(page);
      sigHistory.push(progressSignature(observation));

      if (isComplete(observation, completionCriteria)) { trajectory.finalState = { success: true, signal: observation.title || "completion criteria met" }; stopReason = "done"; break; }
      const stop = shouldStop({ steps: step, maxSteps, sigHistory, maxNoProgress: 4 });
      if (stop.stop) { stopReason = stop.reason; break; }

      let decision;
      try { decision = parseDecision(await callModel(cfg, buildMessages(instruction, observation, trajectory.steps))); }
      catch (err) { stopReason = `model-error:${err.message}`; break; }
      if (!decision) { stopReason = "undecidable"; break; }

      const action = decisionToAction(decision, observation.candidates);
      if (!action) { stopReason = "invalid-decision"; break; }
      if (action.type === "done") { trajectory.finalState = { success: true, signal: action.reason || observation.title }; stopReason = "model-done"; break; }
      if (action.type === "blocked-password") { stopReason = "needs-auth"; break; } // credentials come from the vault, never typed here

      const verdict = validateAction(action, { mode, allowedDomains, confirmed: input.confirmedDestructive });
      if (!verdict.ok) {
        trajectory.steps.push({ observation: { url: observation.url, title: observation.title }, action: { type: action.type, label: action.label, target: action.target }, feedback: { error: `blocked:${verdict.reason}` } });
        stopReason = `action-blocked:${verdict.reason}`;
        break;
      }

      let feedback = {};
      try { await performAction(page, action); feedback = await captureFeedback(page); }
      catch (err) { feedback = { error: err.message }; }

      trajectory.steps.push({
        observation: { url: observation.url, title: observation.title },
        // value is recorded as a placeholder note only — the literal is never logged
        action: { type: action.type, label: action.label, target: action.target, note: action.value != null ? VALUE_PLACEHOLDER_NOTE : undefined, risk: verdict.risk },
        feedback,
      });
      if (feedback.success) { trajectory.finalState = { success: true, signal: feedback.success }; stopReason = "success-feedback"; break; }
    }

    if (!stopReason) stopReason = "step-cap";
    const result = { ok: true, stopReason, success: trajectory.finalState.success, steps: trajectory.steps.length, finalUrl: page.url(), trajectory };

    // On a successful self-run, distill the trajectory into a procedure card —
    // exactly the same distiller a human demonstration would feed.
    if (input.distill !== false && trajectory.finalState.success) {
      result.card = distillProcedureCard(trajectory, { runs: 1, success: true });
    }
    emit(result, 0);
  } catch (err) {
    emit({ ok: false, code: "RUN_FAILED", message: err.message, steps: trajectory.steps.length }, 1);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => emit({ ok: false, code: "FATAL", message: err.message }, 1));
}

module.exports = { decisionToAction, parseDecision, buildMessages, decisionMenu };
