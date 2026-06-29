#!/usr/bin/env node
"use strict";

/**
 * Professional web-system learning orchestrator.
 *
 * This is the one default entrypoint for learning a web/OA/admin system. It
 * composes the approved bounded learners instead of relying on ad-hoc browser
 * scripts in chat:
 *
 *   published contracts -> bootstrap HAR scan -> frontend JS intelligence ->
 *   source-seeded expanded scan -> HAR contracts -> auth recipe -> finalizer
 *
 * The orchestrator is intentionally in the skill layer. Lily core only observes
 * generic foreground tools and [lily-progress] heartbeats.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT_DIR = __dirname;
const DEFAULT_MAX_PAGES = 120;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_WORK_DIR = ".lily-work/web-system-learning";

function usage() {
  return [
    "Usage:",
    "  node scripts/learn_web_system.cjs --base-url <url> --allow-domain <host> --storage-state <session.json> [options]",
    "",
    "Options:",
    "  --system-id <id>              Stable id for the generated learned skill.",
    "  --name <name>                 Display name for the generated learned skill.",
    "  --work-dir <dir>              Learning artifact directory. Default: .lily-work/web-system-learning",
    "  --out <dir>                   Generated skill draft output directory.",
    "  --max-pages <n>               Max pages for each scanner pass. Default: 120",
    "  --timeout-ms <n>              Per-page scan timeout. Default: 60000",
    "  --headful                     Show the browser during scan.",
    "  --learning-mode <mode>        read-only, contract-probe, or test-lab.",
    "  --test-environment <name>     Required by scan_web_system.py for test-lab.",
    "  --allow-mutating-learning     Only valid with --learning-mode test-lab.",
    "  --plan-only                   Print the deterministic phase plan and exit.",
    "  --dry-run                     Validate scanner/finalizer config where supported.",
  ].join("\n");
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

function slug(value, fallback = "web-system") {
  const out = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || fallback;
  return /^[a-z]/.test(out) ? out : `web-${out}`.slice(0, 63);
}

function parseArgs(argv) {
  const args = {
    baseUrl: "",
    allowDomains: [],
    storageState: "",
    systemId: "",
    name: "",
    workDir: "",
    out: "",
    maxPages: DEFAULT_MAX_PAGES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headful: false,
    learningMode: "read-only",
    testEnvironment: "",
    allowMutatingLearning: false,
    planOnly: false,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--allow-domain" || arg === "--allowed-domain") args.allowDomains.push(normalizeHost(argv[++i]));
    else if (arg === "--allowlist") args.allowDomains.push(...String(argv[++i] || "").split(",").map(normalizeHost).filter(Boolean));
    else if (arg === "--storage-state" || arg === "--session-path") args.storageState = argv[++i];
    else if (arg === "--system-id") args.systemId = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--work-dir") args.workDir = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--max-pages") args.maxPages = Number(argv[++i] || 0) || DEFAULT_MAX_PAGES;
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i] || 0) || DEFAULT_TIMEOUT_MS;
    else if (arg === "--headful") args.headful = true;
    else if (arg === "--learning-mode") args.learningMode = argv[++i];
    else if (arg === "--test-environment") args.testEnvironment = argv[++i];
    else if (arg === "--allow-mutating-learning") args.allowMutatingLearning = true;
    else if (arg === "--plan-only") args.planOnly = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.baseUrl) throw new Error("Missing --base-url");
  const baseHost = normalizeHost(args.baseUrl);
  if (!args.allowDomains.length) args.allowDomains = [baseHost];
  if (!args.workDir) args.workDir = DEFAULT_WORK_DIR;
  if (!args.systemId) args.systemId = slug(args.name || baseHost || "web-system", "web-system");
  return args;
}

function resolvePath(file) {
  return path.resolve(file);
}

function scriptPath(name) {
  return path.join(SCRIPT_DIR, name);
}

function jsonReadIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return "python3";
}

function emitProgress(phase, status, detail = "") {
  const payload = { phase, status, detail, at: new Date().toISOString() };
  process.stderr.write(`[lily-progress] ${JSON.stringify(payload)}\n`);
}

function allowDomainArgs(args, flag = "--allow-domain") {
  return args.allowDomains.flatMap((domain) => [flag, domain]);
}

function scannerAllowDomainArgs(args) {
  return args.allowDomains.flatMap((domain) => ["--allowed-domain", domain]);
}

function buildPaths(args) {
  const workDir = resolvePath(args.workDir);
  return {
    workDir,
    contracts: path.join(workDir, "api-contracts.json"),
    bootstrapHar: path.join(workDir, "scan-bootstrap.har"),
    bootstrapScan: path.join(workDir, "scan-bootstrap.json"),
    frontendSource: path.join(workDir, "frontend-source-map.json"),
    expandedHar: path.join(workDir, "scan-expanded.har"),
    expandedScan: path.join(workDir, "scan.json"),
    authRecipe: path.join(workDir, "auth-recipe.json"),
    summary: path.join(workDir, "learning-summary.json"),
  };
}

function scanArgs(args, paths, { out, har, frontendSource = "" }) {
  const argv = [
    scriptPath("scan_web_system.py"),
    "--base-url", args.baseUrl,
    ...scannerAllowDomainArgs(args),
    "--interactive-readonly",
    "--max-pages", String(args.maxPages),
    "--timeout-ms", String(args.timeoutMs),
    "--learning-mode", args.learningMode,
    "--har-path", har,
    "--out", out,
  ];
  if (args.storageState) argv.push("--storage-state", args.storageState);
  if (args.headful) argv.push("--headful");
  if (args.testEnvironment) argv.push("--test-environment", args.testEnvironment);
  if (args.allowMutatingLearning) argv.push("--allow-mutating-learning");
  if (frontendSource) argv.push("--frontend-source", frontendSource);
  if (args.dryRun) argv.push("--dry-run");
  return argv;
}

function buildPlan(args) {
  const paths = buildPaths(args);
  const python = findPython();
  const phases = [
    {
      id: "authPrecondition",
      required: false,
      kind: "precondition",
      command: args.storageState ? ["storage-state", args.storageState] : ["capture-session-required-before-authenticated-learning"],
      outputs: args.storageState ? [args.storageState] : [],
    },
    {
      id: "contractDiscovery",
      required: false,
      kind: "node",
      command: [
        process.execPath,
        scriptPath("discover_contracts.cjs"),
        "--base-url", args.baseUrl,
        ...allowDomainArgs(args),
        ...(args.storageState ? ["--storage-state", args.storageState] : []),
        "--out", paths.contracts,
      ],
      outputs: [paths.contracts],
    },
    {
      id: "bootstrapScan",
      required: true,
      kind: "python",
      command: [python, ...scanArgs(args, paths, { out: paths.bootstrapScan, har: paths.bootstrapHar })],
      outputs: [paths.bootstrapScan, paths.bootstrapHar],
    },
    {
      id: "frontendSource",
      required: false,
      kind: "node",
      command: [
        process.execPath,
        scriptPath("frontend_source_intelligence.cjs"),
        "--har", paths.bootstrapHar,
        "--base-url", args.baseUrl,
        ...allowDomainArgs(args),
        ...(args.storageState ? ["--storage-state", args.storageState] : []),
        "--out", paths.frontendSource,
      ],
      outputs: [paths.frontendSource],
    },
    {
      id: "expandedScan",
      required: true,
      kind: "python",
      command: [
        python,
        ...scanArgs(args, paths, {
          out: paths.expandedScan,
          har: paths.expandedHar,
          frontendSource: paths.frontendSource,
        }),
      ],
      outputs: [paths.expandedScan, paths.expandedHar],
    },
    {
      id: "harContractsBootstrap",
      required: false,
      kind: "node",
      command: [
        process.execPath,
        scriptPath("har_to_contracts.cjs"),
        "--har", paths.bootstrapHar,
        "--base-url", args.baseUrl,
        ...allowDomainArgs(args),
        "--merge", paths.contracts,
        "--out", paths.contracts,
      ],
      outputs: [paths.contracts],
    },
    {
      id: "harContractsExpanded",
      required: false,
      kind: "node",
      command: [
        process.execPath,
        scriptPath("har_to_contracts.cjs"),
        "--har", paths.expandedHar,
        "--base-url", args.baseUrl,
        ...allowDomainArgs(args),
        "--merge", paths.contracts,
        "--out", paths.contracts,
      ],
      outputs: [paths.contracts],
    },
    {
      id: "authRecipe",
      required: false,
      kind: "node",
      command: [
        process.execPath,
        scriptPath("learn_auth_recipe.cjs"),
        ...(args.storageState ? ["--storage-state", args.storageState] : []),
        "--har", paths.expandedHar,
        "--base-url", args.baseUrl,
        ...allowDomainArgs(args),
        "--out", paths.authRecipe,
      ],
      outputs: [paths.authRecipe],
      skipWhen: args.storageState ? "" : "missing-storage-state",
    },
    {
      id: "finalize",
      required: true,
      kind: "node",
      command: [
        process.execPath,
        scriptPath("finalize_web_system_learning.cjs"),
        "--scan", paths.expandedScan,
        "--contracts", paths.contracts,
        "--frontend-source", paths.frontendSource,
        "--system-id", args.systemId,
        "--name", args.name || args.systemId,
        ...(args.out ? ["--out", args.out] : []),
      ],
      outputs: args.out ? [args.out] : [],
    },
  ];
  return {
    ok: true,
    kind: "web-system-learning-plan",
    schemaVersion: 1,
    baseUrl: args.baseUrl,
    allowedDomains: args.allowDomains,
    storageState: args.storageState ? "provided" : "missing",
    workDir: paths.workDir,
    paths,
    phases,
    guarantees: [
      "single-default-learning-entrypoint",
      "published-contracts-before-inference",
      "bootstrap-har-before-source-analysis",
      "bounded-same-domain-js-intelligence",
      "source-seeded-expanded-scan",
      "har-to-contracts-from-observed-traffic",
      "auth-recipe-without-raw-token-values",
      "deterministic-finalizer",
    ],
  };
}

function runCommand(phase) {
  emitProgress(phase.id, "started", phase.command.slice(0, 3).join(" "));
  const [cmd, ...argv] = phase.command;
  const result = spawnSync(cmd, argv, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    emitProgress(phase.id, "failed", result.error.message);
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    emitProgress(phase.id, "failed", `exit ${result.status}`);
    return { ok: false, status: result.status };
  }
  emitProgress(phase.id, "completed", "");
  return { ok: true };
}

function inspectScanOrThrow(file, phaseId) {
  const scan = jsonReadIfExists(file);
  if (!scan) throw new Error(`${phaseId} did not write ${file}`);
  if (scan.ok !== true) {
    const code = scan.code || scan.errorCode || "SCAN_NOT_OK";
    const message = scan.message || scan.error || "scan failed";
    throw new Error(`${phaseId} failed: ${code}: ${message}`);
  }
  if (scan.code === "AUTH_NOT_RESTORED" || scan.relearnRecommended === true) {
    throw new Error(`${phaseId} requires session recapture: AUTH_NOT_RESTORED`);
  }
  return scan;
}

function outputExists(file) {
  return Boolean(file && fs.existsSync(file));
}

function finalizeCommandFor(plan, finalScanPath) {
  const finalizePhase = plan.phases.find((p) => p.id === "finalize");
  const systemIdIndex = finalizePhase?.command?.indexOf("--system-id") ?? -1;
  const nameIndex = finalizePhase?.command?.indexOf("--name") ?? -1;
  const outIndex = finalizePhase?.command?.indexOf("--out") ?? -1;
  const argv = [
    process.execPath,
    scriptPath("finalize_web_system_learning.cjs"),
    "--scan", finalScanPath,
    "--system-id", systemIdIndex >= 0 ? finalizePhase.command[systemIdIndex + 1] : "web-system",
  ];
  if (nameIndex >= 0) argv.push("--name", finalizePhase.command[nameIndex + 1]);
  if (outputExists(plan.paths.contracts)) argv.push("--contracts", plan.paths.contracts);
  if (outputExists(plan.paths.frontendSource)) argv.push("--frontend-source", plan.paths.frontendSource);
  if (outIndex >= 0) argv.push("--out", finalizePhase.command[outIndex + 1]);
  return argv;
}

function authRecipeCommandFor(plan) {
  const authPhase = plan.phases.find((p) => p.id === "authRecipe");
  if (!authPhase) return [];
  const har = outputExists(plan.paths.expandedHar) ? plan.paths.expandedHar : plan.paths.bootstrapHar;
  const command = [...authPhase.command];
  const harIndex = command.indexOf("--har");
  if (harIndex >= 0) command[harIndex + 1] = har;
  return command;
}

function writeSummary(file, summary) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function runPlan(plan) {
  fs.mkdirSync(plan.workDir, { recursive: true });
  const results = [];
  const warnings = [];
  let finalScanPath = plan.paths.expandedScan;

  for (const phase of plan.phases) {
    if (phase.id === "authPrecondition") {
      const ok = plan.storageState === "provided";
      const warning = ok ? "" : "No storageState provided; authenticated systems should run capture_session.cjs before this orchestrator.";
      if (warning) warnings.push(warning);
      results.push({ id: phase.id, ok, skipped: true, warning });
      continue;
    }
    if (phase.id === "authRecipe" && phase.skipWhen) {
      results.push({ id: phase.id, ok: true, skipped: true, reason: phase.skipWhen });
      continue;
    }
    if (phase.id === "harContractsExpanded" && !outputExists(plan.paths.expandedHar)) {
      results.push({ id: phase.id, ok: true, skipped: true, reason: "missing-expanded-har" });
      continue;
    }
    if (phase.id === "expandedScan" && !outputExists(plan.paths.frontendSource)) {
      warnings.push("frontend-source-map.json was not available; using bootstrap scan as the final scan.");
      finalScanPath = plan.paths.bootstrapScan;
      results.push({ id: phase.id, ok: true, skipped: true, reason: "missing-frontend-source-map" });
      continue;
    }
    const phaseToRun = phase.id === "finalize"
      ? { ...phase, command: finalizeCommandFor(plan, finalScanPath) }
      : phase.id === "authRecipe"
        ? { ...phase, command: authRecipeCommandFor(plan) }
      : phase;
    const result = runCommand(phaseToRun);
    results.push({ id: phase.id, ...result });

    if (phase.id === "bootstrapScan" && result.ok) {
      inspectScanOrThrow(plan.paths.bootstrapScan, phase.id);
      finalScanPath = plan.paths.bootstrapScan;
    }
    if (phase.id === "expandedScan" && result.ok) {
      inspectScanOrThrow(plan.paths.expandedScan, phase.id);
      finalScanPath = plan.paths.expandedScan;
    }

    if (!result.ok) {
      if (phase.required) {
        throw new Error(`${phase.id} failed`);
      }
      warnings.push(`${phase.id} failed; continuing with available evidence.`);
    }
  }

  // If expanded scan was skipped, rerun finalizer against bootstrap scan by
  // executing the finalizer directly with corrected paths.
  const finalizeResult = results.find((r) => r.id === "finalize");
  if (finalScanPath !== plan.paths.expandedScan && finalizeResult && finalizeResult.ok === false) {
    throw new Error("finalize failed before bootstrap fallback could be used");
  }

  const summary = {
    ok: true,
    kind: "web-system-learning-summary",
    schemaVersion: 1,
    baseUrl: plan.baseUrl,
    allowedDomains: plan.allowedDomains,
    workDir: plan.workDir,
    paths: plan.paths,
    finalScanPath,
    warnings,
    phases: results,
  };
  writeSummary(plan.paths.summary, summary);
  return summary;
}

function main() {
  const args = parseArgs(process.argv);
  const plan = buildPlan(args);
  if (args.planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (args.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const summary = runPlan(plan);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    const payload = { ok: false, error: String(err?.message || err) };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }
}

module.exports = { parseArgs, buildPlan, normalizeHost, slug };
