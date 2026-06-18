#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
    "  node scripts/execute_web_playbook.cjs --playbook web-system-playbook.json --action web.query-status --plan action-plan.json [--capability-map capability-map.json] [--storage-state state.json] [--confirmed] [--headful] [--dry-run]",
    "",
    "The action plan is model-generated JSON, but this executor validates capability, required parameters, domain, risk, confirmation, and operation shape before touching the browser.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    playbook: null,
    action: null,
    plan: null,
    capabilityMap: null,
    storageState: null,
    confirmed: false,
    headful: false,
    dryRun: false,
    out: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--playbook") args.playbook = argv[++i];
    else if (arg === "--action") args.action = argv[++i];
    else if (arg === "--plan") args.plan = argv[++i];
    else if (arg === "--capability-map") args.capabilityMap = argv[++i];
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
  const operations = plan.operations.map((op, index) => {
    const normalized = normalizeOperation(op, index, actionRisk);
    if (normalized.type === "apiRequest") {
      const contract = resolveApiContract(playbook, actionSpec, normalized);
      const targetUrl = resolveApiRequestUrl(playbook, normalized, contract);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`operations[${index}] apiRequest target is outside allowedDomains`);
      }
      const method = String(normalized.method || contract?.method || "GET").toUpperCase();
      const contractRisk = contract?.risk || (method === "GET" || method === "HEAD" ? "read" : "submit");
      if (RISK_ORDER[contractRisk] > RISK_ORDER[actionRisk]) {
        throw new Error(`operations[${index}] API contract risk ${contractRisk} exceeds action risk ${actionRisk}`);
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
        throw new Error(`operations[${index}] target URL is outside allowedDomains`);
      }
      return { ...normalized, url: targetUrl };
    }
    if (normalized.type === "waitForUrl" && (normalized.url || normalized.path)) {
      const targetUrl = resolveTargetUrl(playbook, normalized);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`operations[${index}] waitForUrl target is outside allowedDomains`);
      }
      return { ...normalized, url: targetUrl };
    }
    if (normalized.type === "waitForResponse" && normalized.url) {
      const targetUrl = resolveTargetUrl(playbook, normalized);
      if (!isAllowedUrl(targetUrl, allowedDomains)) {
        throw new Error(`operations[${index}] waitForResponse target is outside allowedDomains`);
      }
      return { ...normalized, url: targetUrl };
    }
    return normalized;
  });

  if (actionRisk !== "read" && !confirmed) {
    return {
      ok: true,
      reviewRequired: true,
      action: actionSpec.action,
      risk: actionRisk,
      confirmation,
      message: "This action requires user review/confirmation before browser execution.",
      operations,
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
    allowedDomains,
  };
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
  const apiResponses = [];
  const screenshots = [];
  const events = [];
  const network = [];

  page.on("request", (request) => {
    const resourceType = request.resourceType();
    if (!["document", "xhr", "fetch"].includes(resourceType)) return;
    const method = request.method();
    if (method === "GET" && resourceType !== "xhr" && resourceType !== "fetch") return;
    network.push({
      type: "request",
      method,
      url: redactUrl(request.url()),
      resourceType,
      postDataShape: shapePostData(request.postData() || ""),
    });
  });

  try {
    for (let index = 0; index < validated.operations.length; index += 1) {
      const op = validated.operations[index];
      events.push({ type: "operation:start", index, operation: op.type, target: targetDescriptor(op) });
      try {
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
          apiResponses.push(record);
          if (op.extract !== false) {
            extracted.push({ label: record.label, text: stringifyApiBody(body, Number(op.maxChars || 6000)) });
          }
          events.push({ type: "apiRequest", method: op.method, url: redactUrl(op.url), status: response.status() });
          if (op.expectStatus && response.status() !== Number(op.expectStatus)) {
            const error = new Error(`API response status ${response.status()} did not match expected ${op.expectStatus}`);
            error.code = "API_STATUS_MISMATCH";
            throw error;
          }
        } else if (op.type === "goto") {
        await page.goto(op.url, { waitUntil: "domcontentloaded", timeout: Number(op.timeoutMs || 30000) });
        events.push({ type: "goto", url: page.url() });
      } else if (op.type === "click") {
        const locator = await locatorFor(page, op);
        await locator.click({ timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "click", target: targetDescriptor(op) });
      } else if (op.type === "fill") {
        const locator = await locatorFor(page, op);
        await locator.fill(String(op.value || ""), { timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "fill", target: targetDescriptor(op), redacted: true });
      } else if (op.type === "select") {
        const locator = await locatorFor(page, op);
        await locator.selectOption(selectOptionValue(op), { timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "select", target: targetDescriptor(op), redacted: true });
      } else if (op.type === "check") {
        const locator = await locatorFor(page, op);
        await locator.check({ timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "check", target: targetDescriptor(op) });
      } else if (op.type === "uncheck") {
        const locator = await locatorFor(page, op);
        await locator.uncheck({ timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "uncheck", target: targetDescriptor(op) });
      } else if (op.type === "upload") {
        const locator = await locatorFor(page, op);
        await locator.setInputFiles(op.files.map((file) => path.resolve(file)), { timeout: Number(op.timeoutMs || 15000) });
        events.push({ type: "upload", target: targetDescriptor(op), fileCount: op.files.length });
      } else if (op.type === "press") {
        await page.keyboard.press(String(op.key));
        events.push({ type: "press", key: op.key });
      } else if (op.type === "wait") {
        await page.waitForTimeout(Math.max(0, Math.min(Number(op.ms || 1000), 10000)));
        events.push({ type: "wait", ms: Number(op.ms || 1000) });
      } else if (op.type === "waitForUrl") {
        await waitForUrl(page, op);
        events.push({ type: "waitForUrl", url: page.url() });
      } else if (op.type === "waitForText") {
        await waitForText(page, op);
        events.push({ type: "waitForText", target: targetDescriptor(op) });
      } else if (op.type === "waitForResponse") {
        await waitForResponse(page, op, validated.allowedDomains);
        events.push({ type: "waitForResponse", target: targetDescriptor(op) });
      } else if (op.type === "assertText") {
        await assertText(page, op);
        events.push({ type: "assertText", target: targetDescriptor(op) });
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
        events.push({ type: "operation:complete", index, operation: op.type });
      } catch (err) {
        return actionFailure(err, { validated, op, index, page, events, extracted, screenshots, network });
      }
    }
    return { ok: true, action: validated.action, events, extracted, apiResponses, screenshots, network, finalUrl: page.url() };
  } finally {
    await context.close();
    await browser.close();
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

function actionFailure(err, { validated, op, index, page, events, extracted, screenshots, network }) {
  return {
    ok: false,
    action: validated.action,
    code: err.code || "WEB_ACTION_FAILED",
    message: err.message,
    failedOperation: {
      index,
      type: op.type,
      risk: op.risk,
      target: targetDescriptor(op),
    },
    recovery: recoveryHints(err, op),
    events,
    extracted,
    screenshots,
    network,
    finalUrl: page.url(),
  };
}

function recoveryHints(err, op) {
  if (err.code === "API_STATUS_MISMATCH" || op.type === "apiRequest") {
    return [
      "The learned API contract may be stale, the browser session may be logged out, or this endpoint now requires a dynamic token.",
      "Retry after confirming the system is logged in. If it fails again, re-run web-system learning with an interactive pass or test-lab contract probe.",
      "For write actions, fall back to the browser plan and keep the user confirmation gate.",
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
    output(validated, args);
    return;
  }
  output(await runBrowser(playbook, validated, args), args);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
  process.exit(1);
});
