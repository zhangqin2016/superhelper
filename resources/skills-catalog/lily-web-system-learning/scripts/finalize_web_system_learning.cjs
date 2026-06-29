#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

function usage() {
  return [
    "Usage:",
    "  node scripts/finalize_web_system_learning.cjs --scan web-system-scan.json [--contracts api-contracts.json] [--frontend-source frontend-source-map.json] [--system-id <id>] [--name <name>] [--out <dir>] [--dry-run]",
    "",
    "Builds web-system-spec.json from deterministic scan/contracts data, then calls create_web_system_skill.cjs.",
    "Use this as the mandatory final step of web-system learning. Do not end a learning turn before this returns ok:true or a concrete error.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { scan: "", contracts: "", frontendSource: "", systemId: "", name: "", out: "", dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan") args.scan = argv[++i];
    else if (arg === "--contracts") args.contracts = argv[++i];
    else if (arg === "--frontend-source") args.frontendSource = argv[++i];
    else if (arg === "--system-id") args.systemId = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.scan) throw new Error("Missing --scan");
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function compactText(value, limit = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function slug(value, fallback = "web-system") {
  const text = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const out = text || fallback;
  return /^[a-z]/.test(out) ? out : `web-${out}`.slice(0, 63);
}

function safeActionId(prefix, value, seen) {
  const base = slug(`${prefix}-${value}`, `${prefix}-action`).slice(0, 56);
  let id = base;
  let n = 2;
  while (seen.has(id) || !ID_RE.test(id)) {
    id = `${base.slice(0, 56)}-${n}`.slice(0, 63);
    n += 1;
  }
  seen.add(id);
  return id;
}

function readContracts(file) {
  if (!file) return null;
  const payload = readJson(file);
  if (payload?.ok !== true || !Array.isArray(payload.contracts)) {
    throw new Error("Invalid --contracts file");
  }
  return payload;
}

function routeLabel(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return compactText(parts.slice(-2).join(" ") || parsed.hostname, 60);
  } catch {
    return compactText(url, 60) || "page";
  }
}

function systemNameFrom(scan, args) {
  if (args.name) return compactText(args.name, 80);
  const firstTitle = (scan.pages || []).map((page) => compactText(page.title, 80)).find(Boolean);
  if (firstTitle) return firstTitle;
  try {
    return new URL(scan.baseUrl).hostname;
  } catch {
    return "Learned Web System";
  }
}

// SPAs routinely fetch lists/details via POST with a FILTER body (e.g.
// POST /api/tasks/my/query {status:[...]}). Classifying those as "submit" buries a
// read behind a confirmation gate and the model can't recognize it as a query, so
// it improvises. Treat a POST/PUT as read when the endpoint looks like a query OR
// the learner already tagged the contract read OR the response is a list.
const QUERY_PATH_RE = /\/(query|queries|search|list|lists|filter|lookup|find|report|reports|stats|statistics|page|browse|export)(?:[/?]|$)/i;
function isReadLikeContract(contract, method) {
  if (method === "GET" || method === "HEAD") return true;
  if (String(contract.risk || "").toLowerCase() === "read") return true;
  if ((method === "POST" || method === "PUT") && QUERY_PATH_RE.test(String(contract.endpoint || ""))) return true;
  const shape = contract.responseShape || {};
  if (method === "POST" && (shape.type === "array" || shape?.shape?.type === "array")) return true;
  return false;
}

function actionFromContract(contract, seen) {
  const method = String(contract.method || "GET").toUpperCase();
  const read = isReadLikeContract(contract, method);
  const label = compactText(contract.summary || contract.operationId || routeLabel(contract.endpoint), 80);
  // Read-like actions get a clean `query-<resource>` id (no method/"submit" noise),
  // so the planner can map "查询/查看…" intents and pass the learned filter params.
  const id = safeActionId(read ? "query" : "submit", contract.operationId || (read ? routeLabel(contract.endpoint) : `${method}-${routeLabel(contract.endpoint)}`), seen);
  return {
    id,
    name: read ? `Query ${label}` : `Run ${method} ${label}`,
    intentExamples: read ? [`查询${label}`, `查看${label}`] : [`提交${label}`, `处理${label}`],
    risk: read ? "read" : "submit",
    confirmation: read ? "none" : "explicit",
    entry: contract.endpoint || "",
    steps: [
      `Use learned API contract ${contract.id || `${method} ${contract.endpoint}`}.`,
      read ? "Return the response as a concise business result." : "Validate fields and show final values before execution.",
    ],
  };
}

function actionFromCandidate(candidate, seen) {
  const label = compactText(candidate.label || candidate.text || candidate.kind || "action", 80);
  const mutating = String(candidate.riskHint || candidate.risk || "").toLowerCase() !== "read";
  const id = safeActionId(mutating ? "submit" : "open", label, seen);
  return {
    id,
    name: mutating ? `Handle ${label}` : `Open ${label}`,
    intentExamples: mutating ? [`处理${label}`, `提交${label}`] : [`查看${label}`, `打开${label}`],
    risk: mutating ? "submit" : "read",
    confirmation: mutating ? "explicit" : "none",
    entry: candidate.sourceUrl || candidate.targetUrl || "",
    steps: [
      candidate.sourceUrl ? `Start from ${candidate.sourceUrl}.` : "Start from the learned page map.",
      mutating ? "Stop for explicit confirmation before submit." : "Open/read the learned page or control and return visible results.",
    ],
  };
}

function actionFromPage(page, seen) {
  const label = compactText(page.title || routeLabel(page.url), 80);
  const id = safeActionId("view", label, seen);
  return {
    id,
    name: `View ${label}`,
    intentExamples: [`查看${label}`, `打开${label}`],
    risk: "read",
    confirmation: "none",
    entry: page.url || "",
    steps: ["Open the learned page.", "Extract the visible headings, tables, forms, and key fields."],
  };
}

function deriveActions(scan, discovered) {
  const seen = new Set();
  const actions = [];
  const pageContracts = [];
  for (const page of Array.isArray(scan.pages) ? scan.pages : []) {
    if (Array.isArray(page.networkContracts)) pageContracts.push(...page.networkContracts);
    for (const form of Array.isArray(page.formContracts) ? page.formContracts : []) {
      if (form?.apiContract) pageContracts.push(form.apiContract);
    }
  }
  const contractSources = [
    ...(Array.isArray(discovered?.contracts) ? discovered.contracts : []),
    ...(Array.isArray(scan.apiContracts) ? scan.apiContracts : []),
    ...pageContracts,
  ];
  for (const contract of contractSources.slice(0, 16)) {
    if (!contract?.endpoint) continue;
    actions.push(actionFromContract(contract, seen));
  }
  for (const candidate of (scan.actionCandidates || []).slice(0, 20)) {
    const label = compactText(candidate.label || candidate.text || "");
    if (!label) continue;
    actions.push(actionFromCandidate(candidate, seen));
    if (actions.length >= 24) break;
  }
  for (const page of (scan.pages || []).filter((item) => item && !item.error).slice(0, 12)) {
    if (actions.length >= 24) break;
    actions.push(actionFromPage(page, seen));
  }
  if (!actions.length) {
    actions.push({
      id: "view-overview",
      name: "View system overview",
      intentExamples: ["查看系统概览", "学习这个系统有什么页面"],
      risk: "read",
      confirmation: "none",
      entry: scan.baseUrl || "",
      steps: ["Open the base URL.", "Summarize visible navigation, pages, and safe read-only actions."],
    });
  }
  return actions;
}

function deriveSpec(scan, discovered, args) {
  if (scan?.ok !== true || scan?.schemaVersion !== 1) throw new Error("Invalid --scan file");
  const baseUrl = String(scan.baseUrl || "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("scan.baseUrl must be http(s)");
  const allowedDomains = (Array.isArray(scan.allowedDomains) ? scan.allowedDomains : [normalizeHost(baseUrl)])
    .map(normalizeHost)
    .filter(Boolean);
  if (!allowedDomains.length) throw new Error("scan.allowedDomains is empty");
  const name = systemNameFrom(scan, args);
  const id = slug(args.systemId || name || normalizeHost(baseUrl), "learned-web-system");
  return {
    id,
    name,
    systemName: name,
    baseUrl,
    allowedDomains,
    summary: `${name} learned from authenticated read-only scan. Coverage: ${scan.coverage?.pageCount ?? (scan.pages || []).length} page(s), ${scan.coverage?.apiContractCount ?? (scan.apiContracts || []).length} API contract(s).`,
    actions: deriveActions(scan, discovered),
  };
}

function runCreateSkill({ specPath, scanPath, contractsPath, frontendSourcePath, out, dryRun }) {
  const createScript = path.join(__dirname, "create_web_system_skill.cjs");
  const argv = [createScript, "--spec", specPath, "--scan", scanPath];
  if (contractsPath) argv.push("--contracts", contractsPath);
  if (frontendSourcePath) argv.push("--frontend-source", frontendSourcePath);
  if (out) argv.push("--out", out);
  if (dryRun) argv.push("--dry-run");
  const result = spawnSync(process.execPath, argv, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `create_web_system_skill exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function main() {
  const args = parseArgs(process.argv);
  const scanPath = path.resolve(args.scan);
  const contractsPath = args.contracts ? path.resolve(args.contracts) : "";
  const frontendSourcePath = args.frontendSource ? path.resolve(args.frontendSource) : "";
  const scan = readJson(scanPath);
  const discovered = contractsPath ? readContracts(contractsPath) : null;
  const spec = deriveSpec(scan, discovered, args);
  const workDir = path.dirname(scanPath) || os.tmpdir();
  const specPath = path.join(workDir, "web-system-spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n", "utf8");
  const createResult = runCreateSkill({
    specPath,
    scanPath,
    contractsPath,
    frontendSourcePath,
    out: args.out,
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify({
    ok: true,
    systemId: spec.id,
    specPath,
    actions: spec.actions.length,
    scannedPages: createResult.scannedPages,
    capabilities: createResult.capabilities,
    apiContracts: createResult.apiContracts,
    frontendSourceAssets: createResult.frontendSourceAssets,
    frontendSourceRouteHints: createResult.frontendSourceRouteHints,
    frontendSourceApiHints: createResult.frontendSourceApiHints,
    outDir: createResult.outDir,
    dryRun: args.dryRun,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
}
