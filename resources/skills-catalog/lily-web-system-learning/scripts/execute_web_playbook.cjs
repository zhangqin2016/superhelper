#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { launchChromium, requirePlaywright } = require("./playwright_runtime.cjs");

const RISK_ORDER = { read: 0, prepare: 1, submit: 2, destructive: 3 };
const READ_OPS = new Set(["goto", "apiRequest", "wait", "waitForUrl", "waitForText", "waitForResponse", "assertText", "extract", "screenshot"]);
const PLAN_OPS = new Set([
  "apiRequest",
  "goto",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "upload",
  "press",
  "wait",
  "waitForUrl",
  "waitForText",
  "waitForResponse",
  "assertText",
  "extract",
  "screenshot",
]);
const LOCATOR_FIELDS = ["selector", "role", "label", "placeholder", "testId", "text"];

function usage() {
  return [
    "Usage:",
    "  node scripts/execute_web_playbook.cjs --playbook web-system-playbook.json --action web.query-status --plan action-plan.json [--capability-map capability-map.json] [--storage-state state.json] [--audit-log audit.jsonl] [--confirmed] [--allow-browser] [--allow-browser-fallback] [--headful] [--dry-run]",
    "",
    "The action plan is model-generated JSON, but this executor validates capability, required parameters, domain, risk, confirmation, and operation shape before any execution.",
    "Default runtime is API-first and browser-free. Browser operations require --allow-browser; API-to-browser fallback requires --allow-browser-fallback. plan.rollbackOperations run if a write fails after mutating state; --audit-log appends a durable JSONL trail.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    playbook: null,
    action: null,
    plan: null,
    capabilityMap: null,
    storageState: null,
    authRecipe: null,
    confirmed: false,
    allowBrowser: false,
    allowBrowserFallback: false,
    headful: false,
    dryRun: false,
    out: null,
    auditLog: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--playbook") args.playbook = argv[++i];
    else if (arg === "--action") args.action = argv[++i];
    else if (arg === "--plan") args.plan = argv[++i];
    else if (arg === "--capability-map") args.capabilityMap = argv[++i];
    else if (arg === "--storage-state") args.storageState = argv[++i];
    else if (arg === "--auth-recipe") args.authRecipe = argv[++i];
    else if (arg === "--confirmed") args.confirmed = true;
    else if (arg === "--allow-browser") args.allowBrowser = true;
    else if (arg === "--allow-browser-fallback") args.allowBrowserFallback = true;
    else if (arg === "--headful") args.headful = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--audit-log") args.auditLog = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.playbook || !args.action || !args.plan) throw new Error("Missing --playbook, --action, or --plan");
  if (args.allowBrowserFallback) args.allowBrowser = true;
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

function capabilityByAction(capabilityMap, actionName) {
  if (!capabilityMap) return null;
  const capabilities = Array.isArray(capabilityMap.capabilities) ? capabilityMap.capabilities : [];
  return capabilities.find((capability) => {
    const playbookAction = capability.execution?.playbookAction;
    return capability.id === actionName || capability.action === actionName || playbookAction === actionName;
  }) || null;
}

function validateCapabilityMap(capabilityMap, actionName) {
  if (!capabilityMap) return null;
  if (capabilityMap.schemaVersion !== 1 || !Array.isArray(capabilityMap.capabilities)) {
    throw new Error("capability-map must be schemaVersion 1 and contain capabilities[]");
  }
  const capability = capabilityByAction(capabilityMap, actionName);
  if (!capability) {
    throw new Error(`capability not found for action: ${actionName}`);
  }
  return capability;
}

function validateCapabilityParams(capability, plan) {
  if (!capability || !plan) return null;
  const required = Array.isArray(capability.params?.required) ? capability.params.required : [];
  if (required.length === 0) return null;
  const params = plan.params && typeof plan.params === "object" && !Array.isArray(plan.params) ? plan.params : {};
  const missing = required.filter((paramId) => isMissingParamValue(params[paramId]));
  if (missing.length === 0) return null;
  const askWhenMissing = (Array.isArray(capability.askWhenMissing) ? capability.askWhenMissing : [])
    .filter((item) => missing.includes(item.param));
  return {
    ok: true,
    inputRequired: true,
    action: capability.execution?.playbookAction || capability.action || capability.id,
    capability: capabilitySummary(capability),
    missingParams: missing,
    askWhenMissing,
    message: "Required input is missing before this capability can run.",
  };
}

function isMissingParamValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function enrichWithCapability(validated, capability) {
  if (!capability) return validated;
  return {
    ...validated,
    capability: capabilitySummary(capability),
    successSignal: capability.successSignal || null,
    staleSignals: Array.isArray(capability.staleSignals) ? capability.staleSignals : [],
    recovery: capability.recovery || null,
    audit: capability.audit || null,
  };
}

function capabilitySummary(capability) {
  return {
    id: capability.id || "",
    action: capability.action || capability.execution?.playbookAction || "",
    title: capability.title || "",
    risk: capability.risk || "",
    confirmation: capability.confirmation || "",
    execution: capability.execution
      ? {
          preferred: capability.execution.preferred || "",
          fallback: capability.execution.fallback || "",
          apiContractRefs: Array.isArray(capability.execution.apiContractRefs) ? capability.execution.apiContractRefs : [],
          playbookAction: capability.execution.playbookAction || "",
        }
      : null,
  };
}

function normalizeOperation(op, index, actionRisk) {
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new Error(`operations[${index}] must be an object`);
  }
  const type = String(op.type || "").trim();
  if (!PLAN_OPS.has(type)) throw new Error(`operations[${index}].type is invalid: ${type}`);
  const declaredRisk = String(op.risk || defaultRiskForOperation(op, type)).trim();
  if (!(declaredRisk in RISK_ORDER)) throw new Error(`operations[${index}].risk is invalid: ${declaredRisk}`);
  if (RISK_ORDER[declaredRisk] > RISK_ORDER[actionRisk]) {
    throw new Error(`operations[${index}] risk ${declaredRisk} exceeds action risk ${actionRisk}`);
  }
  if (actionRisk === "read" && declaredRisk !== "read") {
    throw new Error(`read action cannot include non-read operation: operations[${index}]`);
  }
  if (type === "fill" && !hasLocator(op)) throw new Error(`operations[${index}] fill requires selector, label, placeholder, role, testId, or text`);
  if (type === "select" && !hasLocator(op)) throw new Error(`operations[${index}] select requires selector, label, placeholder, role, testId, or text`);
  if (type === "select" && op.value === undefined && op.optionLabel === undefined && op.index === undefined) {
    throw new Error(`operations[${index}] select requires value, optionLabel, or index`);
  }
  if ((type === "check" || type === "uncheck") && !hasLocator(op)) {
    throw new Error(`operations[${index}] ${type} requires selector, label, placeholder, role, testId, or text`);
  }
  if (type === "upload" && (!hasLocator(op) || !Array.isArray(op.files) || op.files.length === 0)) {
    throw new Error(`operations[${index}] upload requires a locator and a non-empty files array`);
  }
  if (type === "press" && !op.key) throw new Error(`operations[${index}].key is required for press`);
  if (type === "apiRequest") validateApiRequestShape(op, index);
  if (type === "click" && !hasLocator(op)) {
    throw new Error(`operations[${index}] click requires selector, role, label, placeholder, testId, or text`);
  }
  if ((type === "waitForText" || type === "assertText") && !op.text && !op.selector) {
    throw new Error(`operations[${index}] ${type} requires text or selector`);
  }
  if (type === "waitForUrl" && !op.url && !op.path && !op.urlContains && !op.urlPattern) {
    throw new Error(`operations[${index}] waitForUrl requires url, path, urlContains, or urlPattern`);
  }
  if (type === "waitForResponse" && !op.urlContains && !op.urlPattern && !op.url) {
    throw new Error(`operations[${index}] waitForResponse requires url, urlContains, or urlPattern`);
  }
  return { ...op, type, risk: declaredRisk };
}

function defaultRiskForOperation(op, type) {
  if (type === "apiRequest") {
    const method = String(op.method || "GET").toUpperCase();
    return method === "GET" || method === "HEAD" ? "read" : "submit";
  }
  if (READ_OPS.has(type)) return "read";
  return type === "fill" ? "prepare" : "submit";
}

function validateApiRequestShape(op, index) {
  if (!op.contractId && !op.url && !op.path) {
    throw new Error(`operations[${index}] apiRequest requires contractId, url, or path`);
  }
  const method = String(op.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new Error(`operations[${index}] apiRequest method is invalid: ${method}`);
  }
  if (op.headers && typeof op.headers !== "object") {
    throw new Error(`operations[${index}] apiRequest headers must be an object`);
  }
  for (const key of Object.keys(op.headers || {})) {
    if (/(authorization|cookie|token|secret|api-key|apikey|password)/i.test(key)) {
      throw new Error(`operations[${index}] apiRequest must not include credential header: ${key}`);
    }
  }
  if (op.body !== undefined && method === "GET") {
    throw new Error(`operations[${index}] GET apiRequest cannot include body`);
  }
}

function hasLocator(op) {
  return LOCATOR_FIELDS.some((field) => op[field] !== undefined && String(op[field]).trim()) || Array.isArray(op.candidates);
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
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("plan must be an object");
  const planAction = String(plan.action || actionSpec.action || "");
  if (planAction !== actionSpec.action && planAction !== action) {
    throw new Error(`plan.action does not match requested action: ${planAction}`);
  }
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
    throw new Error("plan.operations must be a non-empty array");
  }
  const operations = resolveOperations(playbook, actionSpec, actionRisk, allowedDomains, plan.operations, "operations");
  // Optional declared fallback (browser path when the API path fails/stale) and
  // rollback (compensating steps when a write fails mid-way). Both are held to
  // the same risk ceiling and domain allowlist as the primary operations.
  const fallbackOperations = Array.isArray(plan.fallbackOperations) && plan.fallbackOperations.length
    ? resolveOperations(playbook, actionSpec, actionRisk, allowedDomains, plan.fallbackOperations, "fallbackOperations")
    : [];
  const rollbackOperations = Array.isArray(plan.rollbackOperations) && plan.rollbackOperations.length
    ? resolveOperations(playbook, actionSpec, actionRisk, allowedDomains, plan.rollbackOperations, "rollbackOperations")
    : [];

  if (actionRisk !== "read" && !confirmed) {
    return {
      ok: true,
      reviewRequired: true,
      action: actionSpec.action,
      risk: actionRisk,
      confirmation,
      message: "This action requires user review/confirmation before browser execution.",
      operations,
      fallbackOperations,
      rollbackOperations,
      allowedDomains,
    };
  }

  return {
    ok: true,
    reviewRequired: false,
    action: actionSpec.action,
    risk: actionRisk,
    confirmation,
    operations,
    fallbackOperations,
    rollbackOperations,
    allowedDomains,
    params: plan.params && typeof plan.params === "object" && !Array.isArray(plan.params) ? plan.params : {},
  };
}

/**
 * Normalize + safety-resolve a list of plan operations (risk ceiling, domain
 * allowlist, contract resolution). Shared by primary/fallback/rollback lists so
 * every executable path is validated identically. `label` scopes error messages.
 */
function resolveOperations(playbook, actionSpec, actionRisk, allowedDomains, opList, label) {
  return opList.map((op, index) => {
    const normalized = normalizeOperation(op, index, actionRisk);
    if (normalized.type === "apiRequest") {
      const contract = resolveApiContract(playbook, actionSpec, normalized);
      const targetUrl = resolveApiRequestUrl(playbook, normalized, contract);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`${label}[${index}] apiRequest target is outside allowedDomains`);
      }
      const method = String(normalized.method || contract?.method || "GET").toUpperCase();
      const contractRisk = contract?.risk || (method === "GET" || method === "HEAD" ? "read" : "submit");
      if (RISK_ORDER[contractRisk] > RISK_ORDER[actionRisk]) {
        throw new Error(`${label}[${index}] API contract risk ${contractRisk} exceeds action risk ${actionRisk}`);
      }
      return {
        ...normalized,
        contractId: normalized.contractId || contract?.id || "",
        method,
        url: targetUrl,
        contentType: normalized.contentType || contract?.contentType || "json",
      };
    }
    if (normalized.type === "goto") {
      const targetUrl = resolveTargetUrl(playbook, normalized);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`${label}[${index}] target URL is outside allowedDomains`);
      }
      return { ...normalized, url: targetUrl };
    }
    if (normalized.type === "waitForUrl" && (normalized.url || normalized.path)) {
      const targetUrl = resolveTargetUrl(playbook, normalized);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`${label}[${index}] waitForUrl target is outside allowedDomains`);
      }
      return { ...normalized, url: targetUrl };
    }
    if (normalized.type === "waitForResponse" && normalized.url) {
      const targetUrl = resolveTargetUrl(playbook, normalized);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`${label}[${index}] waitForResponse target is outside allowedDomains`);
      }
      return { ...normalized, url: targetUrl };
    }
    return normalized;
  });
}

function resolveApiContract(playbook, actionSpec, op) {
  const contracts = Array.isArray(playbook.apiContracts) ? playbook.apiContracts : [];
  if (op.contractId) {
    const found = contracts.find((contract) => contract.id === op.contractId);
    if (!found) throw new Error(`apiRequest contractId was not found: ${op.contractId}`);
    return found;
  }
  const refs = Array.isArray(actionSpec.metadata?.apiContractRefs) ? actionSpec.metadata.apiContractRefs : [];
  if (refs.length === 1 && !op.url && !op.path) {
    return contracts.find((contract) => contract.id === refs[0]) || null;
  }
  return null;
}

function resolveApiRequestUrl(playbook, op, contract) {
  const baseUrl = String(playbook.baseUrl || "");
  const raw = op.url || op.path || contract?.endpoint || "";
  if (!raw) throw new Error("apiRequest target URL is missing");
  const url = new URL(String(raw), baseUrl);
  const query = { ...(contract?.defaultQuery || {}), ...(op.query || {}) };
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

async function runBrowser(playbook, validated, args) {
  let chromium;
  try {
    ({ chromium } = requirePlaywright());
  } catch (err) {
    return {
      ok: false,
      code: "PLAYWRIGHT_NODE_MISSING",
      message: "Playwright for Node.js is not installed in this runtime. Install a browser runtime pack or run read-only scan first.",
      detail: err.message,
    };
  }

  const browser = await launchChromium(chromium, { headless: !args.headful });
  const contextOptions = {};
  const storageState = loadStorageState(args.storageState);
  if (storageState) contextOptions.storageState = playwrightStorageState(storageState);
  const context = await browser.newContext(contextOptions);
  await installSessionStorageInitScript(context, storageState);
  const page = await context.newPage();
  const sinks = { extracted: [], apiResponses: [], screenshots: [], events: [], network: [], mutated: [] };

  page.on("request", (request) => {
    const resourceType = request.resourceType();
    if (!["document", "xhr", "fetch"].includes(resourceType)) return;
    sinks.network.push({
      type: "request",
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType,
      postDataShape: shapePostData(request.postData() || ""),
    });
  });

  const opts = { action: validated.action, allowedDomains: validated.allowedDomains, auditLog: args.auditLog };
  try {
    const primary = await runOperationList(page, context, validated.operations, sinks, { ...opts, phase: "primary" });
    if (!primary.failed) {
      appendAudit(args.auditLog, { ts: new Date().toISOString(), action: validated.action, phase: "primary", result: "ok" });
      return { ok: true, action: validated.action, finalUrl: page.url(), ...sinkResult(sinks) };
    }

    const stale = classifyStale(primary.err, primary.op, validated.staleSignals);

    // Legacy in-browser fallback path. Runtime defaults do not auto-enter this
    // path; callers must pass --allow-browser-fallback.
    if (validated.fallbackOperations?.length && isFallbackEligible(primary.err, primary.op)) {
      sinks.events.push({ type: "fallback:start", reason: primary.err.code || "error" });
      const fb = await runOperationList(page, context, validated.fallbackOperations, sinks, { ...opts, phase: "fallback" });
      if (!fb.failed) {
        appendAudit(args.auditLog, { ts: new Date().toISOString(), action: validated.action, phase: "fallback", result: "ok", recoveredFrom: primary.err.code || "error" });
        return {
          ok: true,
          action: validated.action,
          fellBack: true,
          recoveredFrom: { code: primary.err.code || "", op: primary.op.type },
          finalUrl: page.url(),
          ...sinkResult(sinks),
        };
      }
    }

    // Rollback: if a write already mutated state before failing, run the
    // declared compensating steps best-effort so we don't leave partial writes.
    let rolledBack = false;
    if (validated.risk !== "read" && sinks.mutated.length && validated.rollbackOperations?.length) {
      sinks.events.push({ type: "rollback:start", mutatedCount: sinks.mutated.length });
      const rb = await runOperationList(page, context, validated.rollbackOperations, sinks, { ...opts, phase: "rollback" });
      rolledBack = !rb.failed;
      appendAudit(args.auditLog, { ts: new Date().toISOString(), action: validated.action, phase: "rollback", result: rolledBack ? "ok" : "failed" });
    }

    return actionFailure(primary.err, { validated, op: primary.op, index: primary.index, page, sinks, stale, rolledBack });
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Execute one operation list, recording into shared sinks. Returns failure info instead of throwing. */
async function runOperationList(page, context, operations, sinks, opts) {
  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index];
    sinks.events.push({ type: "operation:start", phase: opts.phase, index, operation: op.type, target: targetDescriptor(op) });
    appendAudit(opts.auditLog, { ts: new Date().toISOString(), action: opts.action, phase: opts.phase, index, op: op.type, risk: op.risk, target: targetDescriptor(op) });
    try {
      await executeOperation(page, context, op, sinks, opts.allowedDomains);
      if (RISK_ORDER[op.risk] >= RISK_ORDER.submit) sinks.mutated.push({ phase: opts.phase, index, op: op.type });
      sinks.events.push({ type: "operation:complete", phase: opts.phase, index, operation: op.type });
    } catch (err) {
      appendAudit(opts.auditLog, { ts: new Date().toISOString(), action: opts.action, phase: opts.phase, index, op: op.type, error: err.code || "ERROR", message: err.message });
      return { failed: true, err, op, index };
    }
  }
  return { failed: false };
}

async function executeOperation(page, context, op, sinks, allowedDomains) {
  if (op.type === "apiRequest") {
    const response = await context.request.fetch(op.url, apiRequestOptions(op));
    const body = await readApiResponseBody(response, op);
    const record = {
      label: op.label || op.contractId || op.url,
      contractId: op.contractId || "",
      method: op.method,
      url: redactUrl(op.url),
      status: response.status(),
      ok: response.ok(),
      body,
    };
    sinks.apiResponses.push(record);
    if (op.extract !== false) {
      sinks.extracted.push({ label: record.label, text: stringifyApiBody(body, Number(op.maxChars || 6000)) });
    }
    sinks.events.push({ type: "apiRequest", method: op.method, url: redactUrl(op.url), status: response.status() });
    // Proactive stale/auth detection: a learned contract that now returns
    // 401/403/404 is logged out or gone — fail so fallback/relearn can kick in.
    if ([401, 403, 404].includes(response.status())) {
      const error = new Error(`API responded ${response.status()} (stale contract or logged out)`);
      error.code = `API_${response.status()}`;
      throw error;
    }
    if (op.expectStatus && response.status() !== Number(op.expectStatus)) {
      const error = new Error(`API response status ${response.status()} did not match expected ${op.expectStatus}`);
      error.code = "API_STATUS_MISMATCH";
      throw error;
    }
  } else if (op.type === "goto") {
    await page.goto(op.url, { waitUntil: "domcontentloaded", timeout: Number(op.timeoutMs || 30000) });
    sinks.events.push({ type: "goto", url: page.url() });
  } else if (op.type === "click") {
    await (await locatorFor(page, op)).click({ timeout: Number(op.timeoutMs || 15000) });
    sinks.events.push({ type: "click", target: targetDescriptor(op) });
  } else if (op.type === "fill") {
    await (await locatorFor(page, op)).fill(String(op.value || ""), { timeout: Number(op.timeoutMs || 15000) });
    sinks.events.push({ type: "fill", target: targetDescriptor(op), redacted: true });
  } else if (op.type === "select") {
    await (await locatorFor(page, op)).selectOption(selectOptionValue(op), { timeout: Number(op.timeoutMs || 15000) });
    sinks.events.push({ type: "select", target: targetDescriptor(op), redacted: true });
  } else if (op.type === "check") {
    await (await locatorFor(page, op)).check({ timeout: Number(op.timeoutMs || 15000) });
    sinks.events.push({ type: "check", target: targetDescriptor(op) });
  } else if (op.type === "uncheck") {
    await (await locatorFor(page, op)).uncheck({ timeout: Number(op.timeoutMs || 15000) });
    sinks.events.push({ type: "uncheck", target: targetDescriptor(op) });
  } else if (op.type === "upload") {
    await (await locatorFor(page, op)).setInputFiles(op.files.map((file) => path.resolve(file)), { timeout: Number(op.timeoutMs || 15000) });
    sinks.events.push({ type: "upload", target: targetDescriptor(op), fileCount: op.files.length });
  } else if (op.type === "press") {
    await page.keyboard.press(String(op.key));
    sinks.events.push({ type: "press", key: op.key });
  } else if (op.type === "wait") {
    await page.waitForTimeout(Math.max(0, Math.min(Number(op.ms || 1000), 10000)));
    sinks.events.push({ type: "wait", ms: Number(op.ms || 1000) });
  } else if (op.type === "waitForUrl") {
    await waitForUrl(page, op);
    sinks.events.push({ type: "waitForUrl", url: page.url() });
  } else if (op.type === "waitForText") {
    await waitForText(page, op);
    sinks.events.push({ type: "waitForText", target: targetDescriptor(op) });
  } else if (op.type === "waitForResponse") {
    await waitForResponse(page, op, allowedDomains);
    sinks.events.push({ type: "waitForResponse", target: targetDescriptor(op) });
  } else if (op.type === "assertText") {
    await assertText(page, op);
    sinks.events.push({ type: "assertText", target: targetDescriptor(op) });
  } else if (op.type === "extract") {
    const text = op.selector
      ? await page.locator(op.selector).innerText({ timeout: Number(op.timeoutMs || 15000) })
      : await page.locator("body").innerText({ timeout: Number(op.timeoutMs || 15000) });
    sinks.extracted.push({ label: op.label || op.selector || "page", text: String(text || "").slice(0, Number(op.maxChars || 6000)) });
  } else if (op.type === "screenshot") {
    const file = path.resolve(op.path || `web-connector-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: Boolean(op.fullPage) });
    sinks.screenshots.push(file);
  }
}

function sinkResult(sinks) {
  return {
    events: sinks.events,
    extracted: sinks.extracted,
    apiResponses: sinks.apiResponses,
    screenshots: sinks.screenshots,
    network: sinks.network,
  };
}

const FALLBACK_ELIGIBLE_CODES = new Set(["API_STATUS_MISMATCH", "API_401", "API_403", "API_404", "LOCATOR_NOT_FOUND"]);
const DEFAULT_STALE_SIGNALS = ["api_401", "api_403", "api_404", "api_status_mismatch", "locator_not_found"];
const STALE_CODE_TO_SIGNAL = {
  API_STATUS_MISMATCH: "api_status_mismatch",
  API_401: "api_401",
  API_403: "api_403",
  API_404: "api_404",
  LOCATOR_NOT_FOUND: "locator_not_found",
};

function isFallbackEligible(err, op) {
  return op.type === "apiRequest" || FALLBACK_ELIGIBLE_CODES.has(String(err.code || ""));
}

function classifyStale(err, op, staleSignals) {
  const signals = Array.isArray(staleSignals) && staleSignals.length ? staleSignals : DEFAULT_STALE_SIGNALS;
  const signal = STALE_CODE_TO_SIGNAL[String(err.code || "")] || "";
  const stale = signal ? signals.includes(signal) : false;
  return { stale, staleSignal: stale ? signal : "" };
}

function appendAudit(auditLog, entry) {
  if (!auditLog) return;
  try {
    fs.appendFileSync(path.resolve(auditLog), `${JSON.stringify(entry)}\n`);
  } catch {
    /* audit must never break execution */
  }
}

async function locatorFor(page, op) {
  const timeout = Number(op.timeoutMs || 15000);
  const candidates = buildLocatorCandidates(page, op);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const locator = candidate.locator.first();
      await locator.waitFor({ state: "visible", timeout: Math.min(timeout, Number(candidate.timeoutMs || 2500)) });
      return locator;
    } catch (err) {
      errors.push(`${candidate.kind}: ${err.message}`);
    }
  }
  const error = new Error(`No visible element matched ${targetDescriptor(op)}`);
  error.code = "LOCATOR_NOT_FOUND";
  error.details = errors.slice(0, 6);
  throw error;
}

function buildLocatorCandidates(page, op) {
  const candidates = [];
  const push = (kind, locator, timeoutMs) => candidates.push({ kind, locator, timeoutMs });
  if (op.selector) push(`selector:${op.selector}`, page.locator(op.selector));
  if (op.testId) push(`testId:${op.testId}`, page.getByTestId(String(op.testId)));
  if (op.role) push(`role:${op.role}`, page.getByRole(String(op.role), { name: op.name || op.text || op.label || undefined, exact: Boolean(op.exact) }));
  if (op.label) push(`label:${op.label}`, page.getByLabel(String(op.label), { exact: Boolean(op.exact) }));
  if (op.placeholder) push(`placeholder:${op.placeholder}`, page.getByPlaceholder(String(op.placeholder), { exact: Boolean(op.exact) }));
  if (op.text) push(`text:${op.text}`, page.getByText(String(op.text), { exact: Boolean(op.exact) }));
  for (const candidate of Array.isArray(op.candidates) ? op.candidates : []) {
    if (!candidate || typeof candidate !== "object") continue;
    buildLocatorCandidates(page, candidate).forEach((entry) => push(`fallback:${entry.kind}`, entry.locator, 1200));
  }
  return candidates;
}

function selectOptionValue(op) {
  if (op.value !== undefined) return { value: String(op.value) };
  if (op.optionLabel !== undefined) return { label: String(op.optionLabel) };
  return { index: Number(op.index) };
}

async function waitForUrl(page, op) {
  const timeout = Number(op.timeoutMs || 30000);
  if (op.url) {
    await page.waitForURL(op.url, { timeout });
    return;
  }
  if (op.urlContains) {
    await page.waitForURL((url) => url.href.includes(String(op.urlContains)), { timeout });
    return;
  }
  if (op.urlPattern) {
    const regex = new RegExp(String(op.urlPattern));
    await page.waitForURL((url) => regex.test(url.href), { timeout });
    return;
  }
  await page.waitForURL(op.path, { timeout });
}

async function waitForText(page, op) {
  const timeout = Number(op.timeoutMs || 30000);
  if (op.selector) {
    const locator = op.text ? page.locator(op.selector).filter({ hasText: String(op.text) }) : page.locator(op.selector);
    await locator.first().waitFor({ state: "visible", timeout });
    return;
  }
  await page.getByText(String(op.text), { exact: Boolean(op.exact) }).first().waitFor({ state: "visible", timeout });
}

async function waitForResponse(page, op, allowedDomains) {
  const timeout = Number(op.timeoutMs || 30000);
  await page.waitForResponse((response) => {
    const url = response.url();
    if (!isAllowedUrl(url, allowedDomains)) return false;
    if (op.method && response.request().method() !== String(op.method).toUpperCase()) return false;
    if (op.status && response.status() !== Number(op.status)) return false;
    if (op.url) return url === String(op.url);
    if (op.urlContains) return url.includes(String(op.urlContains));
    if (op.urlPattern) return new RegExp(String(op.urlPattern)).test(url);
    return false;
  }, { timeout });
}

async function assertText(page, op) {
  const timeout = Number(op.timeoutMs || 15000);
  const text = op.selector
    ? await page.locator(op.selector).innerText({ timeout })
    : await page.locator("body").innerText({ timeout });
  const expected = String(op.text || "");
  if (expected && !String(text || "").includes(expected)) {
    const error = new Error(`Expected text was not found: ${expected}`);
    error.code = "ASSERT_TEXT_FAILED";
    throw error;
  }
}

function targetDescriptor(op) {
  if (op.selector) return `selector:${op.selector}`;
  if (op.role) return `role:${op.role}${op.name ? `/${op.name}` : ""}`;
  if (op.label) return `label:${op.label}`;
  if (op.placeholder) return `placeholder:${op.placeholder}`;
  if (op.testId) return `testId:${op.testId}`;
  if (op.text) return `text:${op.text}`;
  if (op.url || op.path || op.urlContains || op.urlPattern) return String(op.url || op.path || op.urlContains || op.urlPattern);
  return op.type || "operation";
}

function apiRequestOptions(op) {
  const options = {
    method: op.method || "GET",
    timeout: Number(op.timeoutMs || 30000),
  };
  const headers = { ...(op.headers || {}) };
  if (Object.keys(headers).length) options.headers = headers;
  if (op.body !== undefined) {
    if (String(op.contentType || "json").toLowerCase() === "form") {
      options.form = op.body;
    } else {
      options.data = op.body;
    }
  }
  return options;
}

async function readApiResponseBody(response, op) {
  const contentType = String(response.headers()["content-type"] || "");
  const maxChars = Number(op.maxChars || 12000);
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return String(await response.text()).slice(0, maxChars);
    }
  }
  return String(await response.text()).slice(0, maxChars);
}

function stringifyApiBody(body, maxChars) {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return String(text || "").slice(0, maxChars);
}

function actionFailure(err, { validated, op, index, page, sinks, stale, rolledBack }) {
  return {
    ok: false,
    action: validated.action,
    code: err.code || "WEB_ACTION_FAILED",
    message: err.message,
    // Stale classification drives the relearn loop instead of a blind retry.
    stale: Boolean(stale?.stale),
    staleSignal: stale?.staleSignal || "",
    relearnRecommended: Boolean(stale?.stale),
    fellBack: false,
    rolledBack: Boolean(rolledBack),
    failedOperation: {
      index,
      type: op.type,
      risk: op.risk,
      target: targetDescriptor(op),
    },
    recovery: recoveryHints(err, op),
    ...sinkResult(sinks),
    finalUrl: page.url(),
  };
}

function recoveryHints(err, op) {
  if (err.code === "API_STATUS_MISMATCH" || op.type === "apiRequest") {
    return [
      "The learned API contract may be stale, the local browser session may be expired, or this endpoint may require a dynamic CSRF/OAuth token learned from browser traffic.",
      "Do not ask the user to fetch cookies, tokens, or credential headers. Refresh the local session with capture_session.cjs and pass the printed sessionPath as --storage-state.",
      "If it still fails, re-run web-system learning with the authenticated browser flow or test-lab contract probe so dynamic token handling is learned by the platform.",
      "Use browser fallback only as an explicit one-off recovery path; normal use should refresh the learned API contract.",
    ];
  }
  if (err.code === "LOCATOR_NOT_FOUND") {
    return [
      "The page likely changed, the user is not logged in, or the action plan used a brittle selector.",
      "Re-run web-system learning on this workspace and prefer label/role/testId/text candidates over a single CSS selector.",
      "If this is a multi-step page, add an explicit waitForText or waitForUrl before this operation.",
    ];
  }
  if (err.code === "ASSERT_TEXT_FAILED") {
    return ["The expected page state was not reached. Check whether the previous action opened the right page or whether the account lacks permission."];
  }
  if (op.type === "waitForResponse") {
    return ["The expected API call did not happen. Re-learn this flow in test-lab mode so the submit contract can capture the actual request."];
  }
  return ["Retry after confirming the page is logged in and visible. If it fails again, re-run learning for this system so selectors and action contracts refresh."];
}

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, "<redacted>");
    return parsed.href;
  } catch {
    return String(value || "");
  }
}

function shapePostData(raw) {
  const text = String(raw || "");
  if (!text) return null;
  try {
    return redactJsonShape(JSON.parse(text));
  } catch {
    try {
      const params = new URLSearchParams(text);
      const shaped = {};
      for (const key of params.keys()) shaped[key] = "<redacted>";
      return { type: "form", fields: shaped };
    } catch {
      return { type: "text", length: text.length };
    }
  }
}

function redactJsonShape(value) {
  if (Array.isArray(value)) return value.slice(0, 3).map(redactJsonShape);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).map((key) => [key, redactJsonShape(value[key])]));
  }
  return `<redacted:${typeof value}>`;
}

function output(payload, args) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (args.out) fs.writeFileSync(path.resolve(args.out), text, "utf8");
  process.stdout.write(text);
}

// Operations that need no browser. An all-API plan runs over plain HTTP with the
// reused session — zero browser launches. This is the fast path the product
// expects: log in once, then operate via learned APIs.
const API_ONLY_OPS = new Set(["apiRequest", "wait"]);

function planNeedsBrowser(operations) {
  return (Array.isArray(operations) ? operations : []).some((op) => !API_ONLY_OPS.has(op.type));
}

function browserExecutionBlocked({ validated, reason, apiResult = null }) {
  return {
    ok: false,
    action: validated.action,
    code: "BROWSER_EXECUTION_DISABLED",
    message: "This learned web-system action would require opening the browser, but browser execution is disabled by default. Re-run learning to capture an API contract, or explicitly allow browser execution for this one operation.",
    reason,
    browserRequired: true,
    browserFallbackAvailable: Boolean(validated.fallbackOperations?.length),
    allowBrowserFlag: reason === "api-fallback" ? "--allow-browser-fallback" : "--allow-browser",
    apiResult: apiResult
      ? {
          ok: apiResult.ok,
          code: apiResult.code || "",
          stale: Boolean(apiResult.stale),
          staleSignal: apiResult.staleSignal || "",
          relearnRecommended: Boolean(apiResult.relearnRecommended),
          transport: apiResult.transport || "",
        }
      : null,
    relearnRecommended: Boolean(apiResult?.relearnRecommended || reason === "primary-browser-plan"),
    recovery: [
      "Preferred fix: re-run web-system learning so this capability has a verified API contract and can run without a browser.",
      "Only use browser execution for UI-only systems or one-off recovery, and make that choice explicit.",
    ],
  };
}

function loadStorageState(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch {
    return null;
  }
}

function playwrightStorageState(storageState) {
  if (!storageState || typeof storageState !== "object") return undefined;
  return {
    cookies: Array.isArray(storageState.cookies) ? storageState.cookies : [],
    origins: Array.isArray(storageState.origins)
      ? storageState.origins.map((origin) => ({
          origin: origin.origin,
          localStorage: Array.isArray(origin.localStorage) ? origin.localStorage : [],
        })).filter((origin) => origin.origin)
      : [],
  };
}

async function installSessionStorageInitScript(context, storageState) {
  const entries = Array.isArray(storageState?.lilySessionStorage)
    ? storageState.lilySessionStorage
        .map((origin) => ({
          origin: String(origin?.origin || ""),
          items: Array.isArray(origin?.sessionStorage) ? origin.sessionStorage : [],
        }))
        .filter((origin) => origin.origin && origin.items.length)
    : [];
  if (!entries.length) return;
  await context.addInitScript((captured) => {
    const match = captured.find((item) => item.origin === window.location.origin);
    if (!match) return;
    for (const entry of match.items || []) {
      if (!entry?.name) continue;
      try {
        window.sessionStorage.setItem(entry.name, String(entry.value || ""));
      } catch {
        /* ignore storage quota/security errors */
      }
    }
  }, entries);
}

function loadAuthRecipe(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch {
    return null;
  }
}

/** Reuse the logged-in session's cookies as a Cookie header (no creds in plans). */
function cookieHeaderFor(url, storageState) {
  if (!storageState || !Array.isArray(storageState.cookies)) return "";
  let host;
  let pathname;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname || "/";
  } catch {
    return "";
  }
  const pairs = [];
  for (const cookie of storageState.cookies) {
    if (!cookie || !cookie.name) continue;
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    if (!domain) continue;
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (!pathname.startsWith(String(cookie.path || "/"))) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join("; ");
}

function cookieValueFor(url, storageState, name) {
  if (!storageState || !Array.isArray(storageState.cookies) || !name) return "";
  let host;
  let pathname;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname || "/";
  } catch {
    return "";
  }
  for (const cookie of storageState.cookies) {
    if (!cookie || cookie.name !== name) continue;
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    if (!domain) continue;
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (!pathname.startsWith(String(cookie.path || "/"))) continue;
    return String(cookie.value || "");
  }
  return "";
}

function localStorageValueFor(url, storageState, key) {
  if (!storageState || !Array.isArray(storageState.origins) || !key) return "";
  let originUrl = "";
  try {
    originUrl = new URL(url).origin;
  } catch {
    return "";
  }
  const origin = storageState.origins.find((item) => item && item.origin === originUrl);
  const values = Array.isArray(origin?.localStorage) ? origin.localStorage : [];
  const found = values.find((item) => item && item.name === key);
  return found ? String(found.value || "") : "";
}

function sessionStorageValueFor(url, storageState, key) {
  if (!storageState || !Array.isArray(storageState.lilySessionStorage) || !key) return "";
  let originUrl = "";
  try {
    originUrl = new URL(url).origin;
  } catch {
    return "";
  }
  const origin = storageState.lilySessionStorage.find((item) => item && item.origin === originUrl);
  const values = Array.isArray(origin?.sessionStorage) ? origin.sessionStorage : [];
  const found = values.find((item) => item && item.name === key);
  return found ? String(found.value || "") : "";
}

function applyAuthRecipeHeaders(headers, url, storageState, authRecipe) {
  const rules = Array.isArray(authRecipe?.headerRules) ? authRecipe.headerRules : [];
  for (const rule of rules) {
    const name = String(rule?.name || "").trim();
    if (!name) continue;
    let value = "";
    if (rule.source === "localStorage") value = localStorageValueFor(url, storageState, rule.key);
    else if (rule.source === "sessionStorage") value = sessionStorageValueFor(url, storageState, rule.key);
    else if (rule.source === "cookie") value = cookieValueFor(url, storageState, rule.key);
    if (!value) continue;
    const formatted = String(rule.format || "{{value}}").replaceAll("{{value}}", value);
    if (formatted) headers[name] = formatted;
  }
  return headers;
}

async function execApiRequestHttp(op, sinks, storageState, authRecipe) {
  const headers = { ...(op.headers || {}) };
  const cookie = cookieHeaderFor(op.url, storageState);
  if (cookie) headers.cookie = cookie;
  applyAuthRecipeHeaders(headers, op.url, storageState, authRecipe);
  const method = String(op.method || "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";
  // Idempotency (opt-in): a non-idempotent write that fails on a NETWORK error
  // can't be safely retried without a stable key (it could double-submit). When the
  // plan marks op.idempotent, inject a stable Idempotency-Key and allow ONE
  // network-error retry that reuses the SAME key, so the server dedupes. HTTP status
  // errors (4xx/5xx) are never retried here. Fail-safe: no flag => today's behavior.
  if (op.idempotent && mutating) {
    if (!op.__idempotencyKey) op.__idempotencyKey = require("node:crypto").randomUUID();
    const keyHeader = String(op.idempotencyHeader || "Idempotency-Key");
    if (!headers[keyHeader]) headers[keyHeader] = op.__idempotencyKey;
  }
  let body;
  if (op.body !== undefined && mutating) {
    if (String(op.contentType || "json").toLowerCase() === "form") {
      body = new URLSearchParams(op.body).toString();
      headers["content-type"] = headers["content-type"] || "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(op.body);
      headers["content-type"] = headers["content-type"] || "application/json";
    }
  }
  const attempts = op.idempotent && mutating ? 2 : 1;
  let res;
  let netErr = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(op.timeoutMs || 30000));
    try {
      res = await fetch(op.url, { method, headers, body, redirect: "follow", signal: controller.signal });
      netErr = null;
      break;
    } catch (err) {
      netErr = err;
      if (attempt + 1 < attempts) {
        sinks.events.push({ type: "apiRequest:retry", reason: "network", url: redactUrl(op.url), attempt: attempt + 1 });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (netErr) throw netErr;
  // Act as a cookie jar across the operation sequence: merge any rotated Set-Cookie
  // (session OR CSRF double-submit tokens like XSRF-TOKEN) back into storageState so
  // the NEXT request's cookie + CSRF header use the fresh value. Stateless `fetch`
  // would otherwise resend the captured-once token and trip 403 on writes. Purely
  // additive — no Set-Cookie means no change (today's behavior).
  mergeSetCookies(storageState, res, op.url);
  const contentType = String(res.headers.get("content-type") || "");
  const text = await res.text();
  let parsed = text;
  if (contentType.includes("json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  sinks.apiResponses.push({
    label: op.label || op.contractId || op.url,
    contractId: op.contractId || "",
    method,
    url: redactUrl(op.url),
    status: res.status,
    ok: res.ok,
    body: parsed,
  });
  if (op.extract !== false) {
    sinks.extracted.push({ label: op.label || op.contractId || op.url, text: stringifyApiBody(parsed, Number(op.maxChars || 6000)) });
  }
  sinks.events.push({ type: "apiRequest", method, url: redactUrl(op.url), status: res.status, transport: "http" });
  if ([401, 403, 404].includes(res.status)) {
    const error = new Error(`API responded ${res.status} (stale contract or logged out)`);
    error.code = `API_${res.status}`;
    throw error;
  }
  if (op.expectStatus && res.status !== Number(op.expectStatus)) {
    const error = new Error(`API response status ${res.status} did not match expected ${op.expectStatus}`);
    error.code = "API_STATUS_MISMATCH";
    throw error;
  }
}

// --- session refresh on expiry (token/cookie) -------------------------------
// A learned session expires (401/403) far more often than its contracts go
// stale. If learning captured a refresh endpoint (auth-recipe.refreshCandidates),
// call it ONCE per run, merge any rotated Set-Cookie back into the in-memory
// session, and let the caller retry — instead of forcing a full re-learn /
// re-login. DETERMINISTIC + FAIL-SAFE: any problem returns false and the caller
// falls through to stale handling (explicit browser fallback or relearn), so the
// worst case is a surfaced recoverable state, never a surprise page popup.
function refreshCandidatesFor(authRecipe, allowedDomains) {
  const list = Array.isArray(authRecipe && authRecipe.refreshCandidates) ? authRecipe.refreshCandidates : [];
  return list.filter((c) => c && c.endpoint && isAllowedUrl(String(c.endpoint), allowedDomains));
}

function parseSetCookies(res) {
  try {
    if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  } catch {
    /* ignore */
  }
  const single = res.headers.get && res.headers.get("set-cookie");
  return single ? [single] : [];
}

// Merge rotated Set-Cookie values into the in-memory storageState so the retry
// (and later operations) send the fresh session. Values are never persisted/logged.
function mergeSetCookies(storageState, res, refreshUrl) {
  const cookies = parseSetCookies(res);
  if (!cookies.length) return 0;
  let host = "";
  try {
    host = new URL(refreshUrl).hostname.toLowerCase();
  } catch {
    /* ignore */
  }
  if (!Array.isArray(storageState.cookies)) storageState.cookies = [];
  let updated = 0;
  for (const raw of cookies) {
    const parts = String(raw).split(";");
    const [namePart, ...valRest] = String(parts[0] || "").split("=");
    const name = String(namePart || "").trim();
    if (!name) continue;
    const value = valRest.join("=").trim();
    const attrs = {};
    for (const seg of parts.slice(1)) {
      const eq = seg.indexOf("=");
      if (eq === -1) continue;
      attrs[seg.slice(0, eq).trim().toLowerCase()] = seg.slice(eq + 1).trim();
    }
    const domain = String(attrs.domain || host || "").replace(/^\./, "").toLowerCase();
    const cookiePath = attrs.path || "/";
    const existing = storageState.cookies.find(
      (c) => c && c.name === name && String(c.domain || "").replace(/^\./, "").toLowerCase() === domain,
    );
    if (existing) {
      existing.value = value;
      existing.path = cookiePath;
    } else {
      storageState.cookies.push({ name, value, domain, path: cookiePath });
    }
    updated += 1;
  }
  return updated;
}

async function tryRefreshSession(authRecipe, storageState, allowedDomains, sinks, args) {
  try {
    const candidate = refreshCandidatesFor(authRecipe, allowedDomains)[0];
    if (!candidate) return false;
    const endpoint = String(candidate.endpoint);
    const method = String(candidate.method || "GET").toUpperCase();
    const headers = {};
    const cookie = cookieHeaderFor(endpoint, storageState);
    if (cookie) headers.cookie = cookie;
    applyAuthRecipeHeaders(headers, endpoint, storageState, authRecipe);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(endpoint, { method, headers, redirect: "follow", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const ok = res.ok;
    const merged = ok ? mergeSetCookies(storageState, res, endpoint) : 0;
    sinks.events.push({ type: "auth:refresh", endpoint: redactUrl(endpoint), status: res.status, ok, cookiesUpdated: merged });
    appendAudit(args.auditLog, { ts: new Date().toISOString(), phase: "auth-refresh", endpoint: redactUrl(endpoint), status: res.status, ok });
    return ok;
  } catch {
    return false; // fail-safe: caller falls through to today's stale handling
  }
}

// Run one apiRequest; on 401/403 refresh the session once and retry. A second
// failure (or no refresh candidate / refresh failed) propagates unchanged.
async function execApiRequestWithRefresh(op, sinks, storageState, authRecipe, allowedDomains, refreshState, args) {
  try {
    await execApiRequestHttp(op, sinks, storageState, authRecipe);
  } catch (err) {
    const code = String((err && err.code) || "");
    if ((code !== "API_401" && code !== "API_403") || refreshState.attempted) throw err;
    if (!refreshCandidatesFor(authRecipe, allowedDomains).length) throw err;
    refreshState.attempted = true;
    const refreshed = await tryRefreshSession(authRecipe, storageState, allowedDomains, sinks, args);
    if (!refreshed) throw err;
    await execApiRequestHttp(op, sinks, storageState, authRecipe); // retry once with the refreshed session
  }
}

// --- pagination (opt-in, capped, fail-safe) ---------------------------------
// A learned list endpoint returns one page; without this the agent silently gets
// partial results. When the plan declares op.pagination, fetch subsequent pages
// and aggregate. OPT-IN (no spec → single request = today), CAPPED (maxPages, hard
// ceiling MAX_PAGINATION_PAGES), and FAIL-SAFE: any malformed spec or page error
// stops the loop and keeps what we have (worst case = page 1 = today). The cap is
// logged (never a silent truncation).
const MAX_PAGINATION_PAGES = 50;

function getByPath(obj, pathStr) {
  if (!pathStr) return obj;
  let cur = obj;
  for (const key of String(pathStr).split(".")) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function coerceItems(value) {
  return Array.isArray(value) ? value : [];
}

// --- parameter binding ({{name}} templates) ---------------------------------
// Make playbooks reusable + chainable: operation url/body/headers can reference
// {{name}}, resolved from plan params AND from values extracted out of earlier
// API responses (op.bind: { name: "dot.path" }). A lone "{{name}}" keeps the
// binding's native type; embedded placeholders interpolate as text. Unknown names
// are left intact (fail-safe). SECURITY: a resolved apiRequest URL is re-checked
// against allowedDomains by the caller, so a binding can never redirect off-site.
function applyBindings(value, bindings) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (exact) {
      const resolved = getByPath(bindings, exact[1]);
      return resolved === undefined ? value : resolved;
    }
    // Raw placeholders (body/headers): substitute as text.
    let out = value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, name) => {
      const resolved = getByPath(bindings, name);
      return resolved === undefined ? m : String(resolved);
    });
    // URL paths/queries get {{ }} percent-encoded to %7B%7B..%7D%7D during URL
    // validation; resolve those too, URL-encoding the value so the request stays valid.
    out = out.replace(/%7[bB]%7[bB]([\w.]+)%7[dD]%7[dD]/g, (m, name) => {
      const resolved = getByPath(bindings, name);
      return resolved === undefined ? m : encodeURIComponent(String(resolved));
    });
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => applyBindings(v, bindings));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = applyBindings(value[key], bindings);
    return out;
  }
  return value;
}

function resolveOpBindings(op, bindings) {
  const out = { ...op };
  for (const field of ["url", "path", "body", "headers"]) {
    if (op[field] !== undefined) out[field] = applyBindings(op[field], bindings);
  }
  return out;
}

function setQueryParam(rawUrl, name, value) {
  const u = new URL(rawUrl);
  u.searchParams.set(name, String(value));
  return u.toString();
}

async function fetchPageBody(url, storageState, authRecipe) {
  const headers = {};
  const cookie = cookieHeaderFor(url, storageState);
  if (cookie) headers.cookie = cookie;
  applyAuthRecipeHeaders(headers, url, storageState, authRecipe);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "follow", signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { ok: true, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function paginateApi(op, sinks, storageState, authRecipe) {
  try {
    const pg = op.pagination || {};
    const mode = String(pg.mode || "");
    const param = String(pg.param || "");
    const itemsPath = String(pg.itemsPath || "");
    if (!["page", "offset", "cursor"].includes(mode) || !itemsPath) return; // malformed → single page
    if (mode !== "cursor" && !param) return;
    if (op.method && String(op.method).toUpperCase() !== "GET") return; // only paginate reads
    const first = sinks.apiResponses[sinks.apiResponses.length - 1];
    if (!first || !first.ok) return;

    const maxPages = Math.max(1, Math.min(Number(pg.maxPages || 20), MAX_PAGINATION_PAGES));
    const size = Number(pg.size || 0);
    const items = coerceItems(getByPath(first.body, itemsPath));
    let prevBody = first.body;
    let pages = 1;
    let stopped = "complete";

    while (pages < maxPages) {
      let nextUrl;
      if (mode === "cursor") {
        const cursor = getByPath(prevBody, String(pg.nextPath || ""));
        if (cursor === undefined || cursor === null || cursor === "") {
          stopped = "no-cursor";
          break;
        }
        nextUrl = setQueryParam(op.url, param || "cursor", cursor);
      } else {
        const start = Number(pg.start ?? (mode === "page" ? 1 : 0));
        nextUrl = setQueryParam(op.url, param, mode === "page" ? start + pages : start + pages * (size || 0));
      }
      const page = await fetchPageBody(nextUrl, storageState, authRecipe);
      sinks.events.push({ type: "apiRequest:page", page: pages + 1, url: redactUrl(nextUrl), status: page.status, ok: page.ok });
      if (!page.ok) {
        stopped = `page-${page.status}`;
        break;
      }
      const pageItems = coerceItems(getByPath(page.body, itemsPath));
      items.push(...pageItems);
      prevBody = page.body;
      pages += 1;
      if (mode !== "cursor") {
        if (pageItems.length === 0) {
          stopped = "empty-page";
          break;
        }
        if (size && pageItems.length < size) {
          stopped = "last-page";
          break;
        }
      }
    }
    if (pages >= maxPages) stopped = "max-pages"; // surfaced, never a silent truncation

    sinks.extracted.push({
      label: `${op.label || op.contractId || op.url} (all pages)`,
      text: stringifyApiBody(items, Number(op.maxChars || 12000)),
      paginated: true,
      pages,
      total: items.length,
      stopped,
    });
    sinks.events.push({ type: "pagination:done", pages, total: items.length, stopped });
  } catch (err) {
    // fail-safe: keep page 1 (already recorded), surface why we stopped.
    sinks.events.push({ type: "pagination:stopped", reason: String((err && err.message) || err) });
  }
}

/** Execute an all-API plan over HTTP — no browser launch. */
async function runApiOnly(playbook, validated, args) {
  const storageState = loadStorageState(args.storageState);
  const authRecipe = loadAuthRecipe(args.authRecipe);
  const allowedDomains = Array.isArray(validated.allowedDomains) ? validated.allowedDomains : [];
  const refreshState = { attempted: false };
  // Binding context: seed from plan params, grow with values extracted from API
  // responses (op.bind) so a later op can reference {{name}} (e.g. create -> id -> delete).
  const bindings = { ...(validated.params || {}) };
  const sinks = { extracted: [], apiResponses: [], events: [], network: [], mutated: [] };
  for (let index = 0; index < validated.operations.length; index += 1) {
    const rawOp = validated.operations[index];
    const op = resolveOpBindings(rawOp, bindings); // resolve {{name}} in url/body/headers
    sinks.events.push({ type: "operation:start", phase: "primary", index, operation: op.type, target: targetDescriptor(op) });
    appendAudit(args.auditLog, { ts: new Date().toISOString(), action: validated.action, phase: "primary", transport: "http", index, op: op.type, risk: op.risk });
    try {
      if (op.type === "apiRequest") {
        // SECURITY: a binding must never redirect a request off the allowlist.
        if (op.url && !isAllowedUrl(String(op.url), allowedDomains)) {
          const error = new Error(`apiRequest target is outside allowedDomains after binding: ${redactUrl(op.url)}`);
          error.code = "API_DOMAIN_BLOCKED";
          throw error;
        }
        await execApiRequestWithRefresh(op, sinks, storageState, authRecipe, allowedDomains, refreshState, args);
        if (op.pagination) await paginateApi(op, sinks, storageState, authRecipe);
        // Extract response values into bindings for later {{name}} references.
        if (op.bind && typeof op.bind === "object" && !Array.isArray(op.bind)) {
          const last = sinks.apiResponses[sinks.apiResponses.length - 1];
          if (last && last.ok) {
            for (const [name, dotPath] of Object.entries(op.bind)) {
              const value = getByPath(last.body, String(dotPath));
              if (value !== undefined) bindings[name] = value;
            }
          }
        }
        if (RISK_ORDER[op.risk] >= RISK_ORDER.submit) sinks.mutated.push({ index, op: op.type });
      } else if (op.type === "wait") {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(Number(op.ms || 1000), 10000))));
        sinks.events.push({ type: "wait", ms: Number(op.ms || 1000) });
      }
      sinks.events.push({ type: "operation:complete", phase: "primary", index, operation: op.type });
    } catch (err) {
      appendAudit(args.auditLog, { ts: new Date().toISOString(), action: validated.action, phase: "primary", transport: "http", index, op: op.type, error: err.code || "ERROR", message: err.message });
      const stale = classifyStale(err, op, validated.staleSignals);
      return {
        ok: false,
        action: validated.action,
        transport: "http",
        code: err.code || "WEB_ACTION_FAILED",
        message: err.message,
        stale: Boolean(stale.stale),
        staleSignal: stale.staleSignal,
        relearnRecommended: Boolean(stale.stale),
        failedOperation: { index, type: op.type, risk: op.risk, target: targetDescriptor(op) },
        recovery: recoveryHints(err, op),
        ...sinkResult(sinks),
      };
    }
  }
  appendAudit(args.auditLog, { ts: new Date().toISOString(), action: validated.action, phase: "primary", transport: "http", result: "ok" });
  return { ok: true, action: validated.action, transport: "http", ...sinkResult(sinks) };
}

async function main() {
  const args = parseArgs(process.argv);
  const playbook = readJson(args.playbook, "playbook");
  const plan = readJson(args.plan, "plan");
  const capabilityMap = args.capabilityMap ? readJson(args.capabilityMap, "capability-map") : null;
  const capability = validateCapabilityMap(capabilityMap, args.action);
  const missingInput = validateCapabilityParams(capability, plan);
  if (missingInput) {
    output(missingInput, args);
    return;
  }
  const validated = enrichWithCapability(validatePlan(playbook, args.action, plan, { confirmed: args.confirmed }), capability);
  if (args.dryRun || validated.reviewRequired) {
    appendAudit(args.auditLog, {
      ts: new Date().toISOString(),
      action: validated.action,
      phase: "validate",
      result: validated.reviewRequired ? "review-required" : "validated",
      operations: validated.operations?.length || 0,
      fallbackOperations: validated.fallbackOperations?.length || 0,
      rollbackOperations: validated.rollbackOperations?.length || 0,
    });
    output(validated, args);
    return;
  }
  // Fast path: an all-API plan runs over plain HTTP with the reused session —
  // no browser launch at all. Browser fallback is never automatic by default:
  // the product goal is to operate learned systems without popping pages.
  if (!planNeedsBrowser(validated.operations)) {
    const apiResult = await runApiOnly(playbook, validated, args);
    if (apiResult.ok || !validated.fallbackOperations?.length) {
      output(apiResult, args);
      return;
    }
    if (!args.allowBrowserFallback) {
      output({
        ...apiResult,
        browserFallbackAvailable: true,
        browserFallbackSkipped: true,
        allowBrowserFlag: "--allow-browser-fallback",
        recovery: [
          ...(Array.isArray(apiResult.recovery) ? apiResult.recovery : []),
          "Browser fallback was not run automatically. Re-run learning to refresh the API contract, or explicitly pass --allow-browser-fallback for this one recovery attempt.",
        ],
      }, args);
      return;
    }
    appendAudit(args.auditLog, { ts: new Date().toISOString(), action: validated.action, phase: "fallback", reason: apiResult.code || "api-failed" });
    const fallbackValidated = { ...validated, operations: validated.fallbackOperations, fallbackOperations: [] };
    const fb = await runBrowser(playbook, fallbackValidated, args);
    output({ ...fb, fellBack: true, recoveredFrom: { code: apiResult.code || "", transport: "http" } }, args);
    return;
  }
  if (!args.allowBrowser) {
    output(browserExecutionBlocked({ validated, reason: "primary-browser-plan" }), args);
    return;
  }
  output(await runBrowser(playbook, validated, args), args);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
  process.exit(1);
});
