#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RISK_ORDER = { read: 0, prepare: 1, submit: 2, destructive: 3 };
const READ_OPS = new Set(["goto", "wait", "extract", "screenshot"]);
const PLAN_OPS = new Set(["goto", "click", "fill", "press", "wait", "extract", "screenshot"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/execute_web_playbook.cjs --playbook web-system-playbook.json --action web.query-status --plan action-plan.json [--storage-state state.json] [--confirmed] [--headful] [--dry-run]",
    "",
    "The action plan is model-generated JSON, but this executor validates domain, risk, confirmation, and operation shape before touching the browser.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { playbook: null, action: null, plan: null, storageState: null, confirmed: false, headful: false, dryRun: false, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--playbook") args.playbook = argv[++i];
    else if (arg === "--action") args.action = argv[++i];
    else if (arg === "--plan") args.plan = argv[++i];
    else if (arg === "--storage-state") args.storageState = argv[++i];
    else if (arg === "--confirmed") args.confirmed = true;
    else if (arg === "--headful") args.headful = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.playbook || !args.action || !args.plan) throw new Error("Missing --playbook, --action, or --plan");
  return args;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

function normalizeDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().split("/")[0].split(":")[0];
  }
}

function isAllowedUrl(url, allowedDomains) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const host = normalizeDomain(parsed.href);
  return allowedDomains.includes(host) || allowedDomains.some((domain) => host.endsWith(`.${domain}`));
}

function resolveTargetUrl(playbook, op) {
  const baseUrl = String(playbook.baseUrl || "");
  if (op.url) return new URL(String(op.url), baseUrl).href;
  if (op.path) return new URL(String(op.path), baseUrl).href;
  return baseUrl;
}

function actionByName(playbook, actionName) {
  return (playbook.actions || []).find((action) => action.action === actionName || action.metadata?.legacyActionId === actionName);
}

function normalizeOperation(op, index, actionRisk) {
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new Error(`operations[${index}] must be an object`);
  }
  const type = String(op.type || "").trim();
  if (!PLAN_OPS.has(type)) throw new Error(`operations[${index}].type is invalid: ${type}`);
  const declaredRisk = String(op.risk || (READ_OPS.has(type) ? "read" : type === "fill" ? "prepare" : "submit")).trim();
  if (!(declaredRisk in RISK_ORDER)) throw new Error(`operations[${index}].risk is invalid: ${declaredRisk}`);
  if (RISK_ORDER[declaredRisk] > RISK_ORDER[actionRisk]) {
    throw new Error(`operations[${index}] risk ${declaredRisk} exceeds action risk ${actionRisk}`);
  }
  if (actionRisk === "read" && declaredRisk !== "read") {
    throw new Error(`read action cannot include non-read operation: operations[${index}]`);
  }
  if (type === "fill" && !op.selector) throw new Error(`operations[${index}].selector is required for fill`);
  if (type === "press" && !op.key) throw new Error(`operations[${index}].key is required for press`);
  if (type === "click" && !op.selector && !op.role && !op.text) {
    throw new Error(`operations[${index}] click requires selector, role, or text`);
  }
  return { ...op, type, risk: declaredRisk };
}

function validatePlan(playbook, action, plan, { confirmed }) {
  if (!playbook || typeof playbook !== "object") throw new Error("playbook must be an object");
  const allowedDomains = Array.isArray(playbook.allowedDomains) ? playbook.allowedDomains.map(normalizeDomain).filter(Boolean) : [];
  if (allowedDomains.length === 0) throw new Error("playbook.allowedDomains is required");
  if (!isAllowedUrl(String(playbook.baseUrl || ""), allowedDomains)) {
    throw new Error("playbook.baseUrl is outside allowedDomains");
  }

  const actionSpec = actionByName(playbook, action);
  if (!actionSpec) throw new Error(`action not found in playbook: ${action}`);
  const actionRisk = String(actionSpec.risk || "read");
  const confirmation = String(actionSpec.confirmation || (actionRisk === "read" ? "none" : "review"));
  if (actionRisk !== "read" && !confirmed) {
    return {
      ok: true,
      reviewRequired: true,
      action: actionSpec.action,
      risk: actionRisk,
      confirmation,
      message: "This action requires user review/confirmation before browser execution.",
      plan,
    };
  }

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("plan must be an object");
  const planAction = String(plan.action || actionSpec.action || "");
  if (planAction !== actionSpec.action && planAction !== action) {
    throw new Error(`plan.action does not match requested action: ${planAction}`);
  }
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
    throw new Error("plan.operations must be a non-empty array");
  }
  const operations = plan.operations.map((op, index) => {
    const normalized = normalizeOperation(op, index, actionRisk);
    if (normalized.type === "goto") {
      const targetUrl = resolveTargetUrl(playbook, normalized);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`operations[${index}] target URL is outside allowedDomains`);
      }
      return { ...normalized, url: targetUrl };
    }
    return normalized;
  });

  return {
    ok: true,
    reviewRequired: false,
    action: actionSpec.action,
    risk: actionRisk,
    confirmation,
    operations,
    allowedDomains,
  };
}

async function runBrowser(playbook, validated, args) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (err) {
    return {
      ok: false,
      code: "PLAYWRIGHT_NODE_MISSING",
      message: "Playwright for Node.js is not installed in this runtime. Install a browser runtime pack or run read-only scan first.",
      detail: err.message,
    };
  }

  const browser = await chromium.launch({ headless: !args.headful });
  const contextOptions = {};
  if (args.storageState) contextOptions.storageState = path.resolve(args.storageState);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const extracted = [];
  const screenshots = [];
  const events = [];

  try {
    for (const op of validated.operations) {
      if (op.type === "goto") {
        await page.goto(op.url, { waitUntil: "domcontentloaded", timeout: Number(op.timeoutMs || 30000) });
        events.push({ type: "goto", url: page.url() });
      } else if (op.type === "click") {
        await locatorFor(page, op).click({ timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "click", target: op.selector || op.role || op.text });
      } else if (op.type === "fill") {
        await page.locator(op.selector).fill(String(op.value || ""), { timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "fill", selector: op.selector, redacted: true });
      } else if (op.type === "press") {
        await page.keyboard.press(String(op.key));
        events.push({ type: "press", key: op.key });
      } else if (op.type === "wait") {
        await page.waitForTimeout(Math.max(0, Math.min(Number(op.ms || 1000), 10000)));
        events.push({ type: "wait", ms: Number(op.ms || 1000) });
      } else if (op.type === "extract") {
        const text = op.selector
          ? await page.locator(op.selector).innerText({ timeout: Number(op.timeoutMs || 15000) })
          : await page.locator("body").innerText({ timeout: Number(op.timeoutMs || 15000) });
        extracted.push({ label: op.label || op.selector || "page", text: String(text || "").slice(0, Number(op.maxChars || 6000)) });
      } else if (op.type === "screenshot") {
        const file = path.resolve(op.path || `web-connector-${Date.now()}.png`);
        await page.screenshot({ path: file, fullPage: Boolean(op.fullPage) });
        screenshots.push(file);
      }
    }
    return { ok: true, action: validated.action, events, extracted, screenshots, finalUrl: page.url() };
  } finally {
    await context.close();
    await browser.close();
  }
}

function locatorFor(page, op) {
  if (op.selector) return page.locator(op.selector);
  if (op.role) return page.getByRole(op.role, { name: op.name || op.text || undefined });
  return page.getByText(String(op.text), { exact: Boolean(op.exact) });
}

function output(payload, args) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (args.out) fs.writeFileSync(path.resolve(args.out), text, "utf8");
  process.stdout.write(text);
}

async function main() {
  const args = parseArgs(process.argv);
  const playbook = readJson(args.playbook, "playbook");
  const plan = readJson(args.plan, "plan");
  const validated = validatePlan(playbook, args.action, plan, { confirmed: args.confirmed });
  if (args.dryRun || validated.reviewRequired) {
    output(validated, args);
    return;
  }
  output(await runBrowser(playbook, validated, args), args);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
  process.exit(1);
});
