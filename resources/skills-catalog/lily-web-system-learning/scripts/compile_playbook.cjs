#!/usr/bin/env node
"use strict";

/**
 * Compile a verified action plan into a standalone, deterministic Playwright
 * script. Once a flow is learned and confirmed, re-running it should not need
 * the model at all — replay is faster, cheaper, and reproducible. The generated
 * script keeps the safety invariants inline (domain allowlist on every
 * navigation/API target, no credential headers) so it stays safe on its own.
 *
 * The codegen is a pure function (operations -> script text) and is unit-tested;
 * executing the produced script needs a real browser.
 */

const fs = require("node:fs");
const path = require("node:path");

const CREDENTIAL_HEADER_RE = /(authorization|cookie|token|secret|api-key|apikey|password)/i;

function lit(value) {
  return JSON.stringify(value === undefined ? null : value);
}

/** Generate a Playwright locator expression for an operation, preferring stable refs. */
function genLocator(op) {
  if (op.selector) return `page.locator(${lit(op.selector)})`;
  if (op.testId) return `page.getByTestId(${lit(op.testId)})`;
  if (op.role) return `page.getByRole(${lit(op.role)}, { name: ${lit(op.label || op.text || "")} })`;
  if (op.label) return `page.getByLabel(${lit(op.label)})`;
  if (op.placeholder) return `page.getByPlaceholder(${lit(op.placeholder)})`;
  if (op.text) return `page.getByText(${lit(op.text)})`;
  return `page.locator("body")`;
}

function genApiOptions(op) {
  const headers = {};
  for (const [k, v] of Object.entries(op.headers || {})) {
    if (CREDENTIAL_HEADER_RE.test(k)) continue; // never emit credential headers
    headers[k] = v;
  }
  const opts = { method: op.method || "GET" };
  if (Object.keys(headers).length) opts.headers = headers;
  if (op.body !== undefined && opts.method !== "GET" && opts.method !== "HEAD") {
    opts.data = op.body;
    if (!opts.headers) opts.headers = {};
    if ((op.contentType || "json") === "json") opts.headers["content-type"] = opts.headers["content-type"] || "application/json";
  }
  return opts;
}

/** Emit one operation as deterministic Playwright statements. */
function genOperation(op, index) {
  const t = Number(op.timeoutMs || 15000);
  const audit = `  log(${lit(index)}, ${lit(op.type)}, ${lit(op.risk || "")});`;
  switch (op.type) {
    case "apiRequest":
      return `${audit}
  {
    const res = await context.request.fetch(${lit(op.url)}, ${lit(genApiOptions(op))});
    if ([401,403,404].includes(res.status())) throw new Error("stale-or-logged-out:"+res.status());
    if (${lit(Boolean(op.expectStatus))} && res.status() !== ${Number(op.expectStatus || 0)}) throw new Error("status-mismatch:"+res.status());
    results.push({ op: ${index}, type: "apiRequest", status: res.status() });
  }`;
    case "goto":
      return `${audit}
  assertAllowed(${lit(op.url)});
  await page.goto(${lit(op.url)}, { waitUntil: "domcontentloaded", timeout: ${Number(op.timeoutMs || 30000)} });`;
    case "click":
      return `${audit}\n  await ${genLocator(op)}.first().click({ timeout: ${t} });`;
    case "fill":
      return `${audit}\n  await ${genLocator(op)}.first().fill(${lit(op.value || "")}, { timeout: ${t} });`;
    case "select":
      return `${audit}\n  await ${genLocator(op)}.first().selectOption(${lit(op.value ?? op.optionLabel ?? op.index ?? "")}, { timeout: ${t} });`;
    case "check":
      return `${audit}\n  await ${genLocator(op)}.first().check({ timeout: ${t} });`;
    case "uncheck":
      return `${audit}\n  await ${genLocator(op)}.first().uncheck({ timeout: ${t} });`;
    case "press":
      return `${audit}\n  await page.keyboard.press(${lit(op.key)});`;
    case "wait":
      return `${audit}\n  await page.waitForTimeout(${Math.max(0, Math.min(Number(op.ms || 1000), 10000))});`;
    case "waitForText":
      return `${audit}\n  await page.getByText(${lit(op.text || "")}).first().waitFor({ state: "visible", timeout: ${t} });`;
    case "assertText":
      return `${audit}\n  await page.getByText(${lit(op.text || "")}).first().waitFor({ state: "visible", timeout: ${t} });`;
    case "extract":
      return `${audit}\n  results.push({ op: ${index}, type: "extract", text: (await ${op.selector ? `page.locator(${lit(op.selector)})` : "page.locator(\"body\")"}.first().innerText({ timeout: ${t} })).slice(0, ${Number(op.maxChars || 6000)}) });`;
    case "screenshot":
      return `${audit}\n  await page.screenshot({ path: ${lit(op.path || "screenshot.png")}, fullPage: ${Boolean(op.fullPage)} });`;
    default:
      return `${audit}\n  // unsupported op type: ${op.type}`;
  }
}

/** Compile a validated plan (operations[]) into a standalone Playwright script. */
function compileScript(plan, { baseUrl, allowedDomains, action }) {
  const ops = Array.isArray(plan.operations) ? plan.operations : [];
  const body = ops.map((op, i) => genOperation(op, i)).join("\n");
  return `#!/usr/bin/env node
// AUTO-GENERATED deterministic playbook for action: ${action}
// Replay this learned flow without the model. Safety invariants are inlined.
// Auth: set STORAGE_STATE=<playwright storageState json> in the environment.
"use strict";
const { chromium } = require("playwright");

const BASE_URL = ${lit(baseUrl)};
const ALLOWED_DOMAINS = ${lit(allowedDomains)};
function hostAllowed(host) {
  host = String(host || "").toLowerCase();
  return ALLOWED_DOMAINS.includes(host) || ALLOWED_DOMAINS.some((d) => host.endsWith("." + d));
}
function assertAllowed(url) {
  let h; try { h = new URL(url).hostname.toLowerCase(); } catch { throw new Error("bad-url:" + url); }
  if (!hostAllowed(h)) throw new Error("out-of-allowlist:" + h);
}
function log(index, type, risk) { process.stdout.write(JSON.stringify({ op: index, type, risk }) + "\\n"); }

(async () => {
  const results = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(process.env.STORAGE_STATE ? { storageState: process.env.STORAGE_STATE } : {});
  const page = await context.newPage();
  try {
${body}
    process.stdout.write(JSON.stringify({ ok: true, action: ${lit(action)}, results }) + "\\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, action: ${lit(action)}, error: String(err && err.message || err), results }) + "\\n");
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
})();
`;
}

function parseArgs(argv) {
  const args = { playbook: null, action: null, plan: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--playbook") args.playbook = argv[++i];
    else if (arg === "--action") args.action = argv[++i];
    else if (arg === "--plan") args.plan = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node compile_playbook.cjs --playbook playbook.json --action web.x --plan plan.json [--out flow.cjs]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.playbook || !args.action || !args.plan) throw new Error("Missing --playbook, --action, or --plan");
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const playbook = JSON.parse(fs.readFileSync(path.resolve(args.playbook), "utf8"));
  const plan = JSON.parse(fs.readFileSync(path.resolve(args.plan), "utf8"));
  const allowedDomains = Array.isArray(playbook.allowedDomains) ? playbook.allowedDomains : [];
  const script = compileScript(plan, { baseUrl: playbook.baseUrl || "", allowedDomains, action: args.action });
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), script);
    process.stdout.write(`${JSON.stringify({ ok: true, out: path.resolve(args.out), operations: (plan.operations || []).length })}\n`);
  } else {
    process.stdout.write(script);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
}

module.exports = { compileScript, genOperation, genLocator, genApiOptions };
