#!/usr/bin/env node
"use strict";

/**
 * Stdio entry for a single learned web system's MCP server.
 *
 * Launched (via the app binary in ELECTRON_RUN_AS_NODE) with --system <draftDir>
 * pointing at an installed learned skill. It exposes each learned capability as a
 * typed MCP tool (see web-system-mcp.js); the injected run() executes the call
 * DETERMINISTICALLY by materializing the capability's API contract + the
 * schema-validated args into a plan and running it through execute_web_playbook
 * (browser-free HTTP, reusing the captured session). No model-authored plans.
 *
 *   node web-system-mcp-stdio.js --system <draftDir> [--storage-state <file>] [--auth-recipe <file>]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createWebSystemMcpServer, buildApiPlan, resolveCapabilityContract } = require("./web-system-mcp.js");

function parseArgs(argv) {
  const args = { system: "", storageState: "", authRecipe: "" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--system") args.system = argv[++i];
    else if (argv[i] === "--storage-state") args.storageState = argv[++i];
    else if (argv[i] === "--auth-recipe") args.authRecipe = argv[++i];
  }
  if (!args.system) throw new Error("Missing --system <draftDir>");
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function slugifySystem(value) {
  return String(value || "system").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "system";
}

function defaultSessionPath(systemId) {
  const base = process.env.LILY_USER_DATA_DIR || path.join(os.tmpdir(), "lily-userdata");
  return path.join(base, "web-sessions", `${slugifySystem(systemId)}.json`);
}

function defaultAuthRecipePath(sessionPath) {
  const ext = path.extname(sessionPath);
  return ext ? sessionPath.slice(0, -ext.length) + ".auth-recipe.json" : `${sessionPath}.auth-recipe.json`;
}

/** Run a materialized plan through execute_web_playbook (browser-free HTTP for APIs). */
function runViaExecutor(draftDir, action, plan, { storageState, authRecipe, confirmed }) {
  return new Promise((resolve) => {
    const executor = path.join(draftDir, "scripts", "execute_web_playbook.cjs");
    if (!fs.existsSync(executor)) {
      resolve({ ok: false, code: "EXECUTOR_MISSING", message: "execute_web_playbook.cjs not found in skill" });
      return;
    }
    const planPath = path.join(os.tmpdir(), `lily-mcp-plan-${crypto.randomUUID()}.json`);
    fs.writeFileSync(planPath, JSON.stringify(plan));
    const argv = [
      executor,
      "--playbook", path.join(draftDir, "web-system-playbook.json"),
      "--action", action,
      "--plan", planPath,
    ];
    const capMap = path.join(draftDir, "capability-map.json");
    if (fs.existsSync(capMap)) argv.push("--capability-map", capMap);
    if (storageState && fs.existsSync(storageState)) argv.push("--storage-state", storageState);
    if (authRecipe && fs.existsSync(authRecipe)) argv.push("--auth-recipe", authRecipe);
    if (confirmed) argv.push("--confirmed");
    const auditLog = path.join(draftDir, "audit-log.jsonl");
    argv.push("--audit-log", auditLog);

    const child = spawn(process.execPath, argv, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { try { fs.unlinkSync(planPath); } catch {} resolve({ ok: false, code: "SPAWN_FAILED", message: String(err?.message || err) }); });
    child.on("close", () => {
      try { fs.unlinkSync(planPath); } catch {}
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, code: "EXECUTOR_OUTPUT", message: (stderr || stdout || "no output").slice(0, 800) });
      }
    });
  });
}

// Ask the MAIN process (connector bridge) to auto re-login a stale session using a
// stored credential. The password stays in the main process; we only get back a
// refreshed storageState file. Returns { ok } — fail-safe, never throws.
async function bridgeRelogin(requestUrl, sessionStatePath) {
  const base = process.env.LILY_CONNECTOR_BRIDGE_URL || "";
  const token = process.env.LILY_CONNECTOR_BRIDGE_TOKEN || "";
  if (!base) return { ok: false };
  try {
    const res = await fetch(`${base}/v1/web-system/relogin`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: requestUrl, sessionStatePath }),
    });
    return await res.json();
  } catch {
    return { ok: false };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const draftDir = path.resolve(args.system);
  const capabilityMap = readJson(path.join(draftDir, "capability-map.json"));
  if (!capabilityMap || !Array.isArray(capabilityMap.capabilities)) {
    process.stderr.write(`web-system-mcp: no capability-map at ${draftDir}\n`);
    process.exit(2);
  }
  const apiMap = readJson(path.join(draftDir, "api-map.json")) || {};
  const apiContracts = Array.isArray(apiMap.contracts) ? apiMap.contracts : [];
  const systemId = capabilityMap.systemId || slugifySystem(draftDir.split(path.sep).pop());
  const systemName = capabilityMap.systemName || systemId;
  const sessionPath = args.storageState || defaultSessionPath(systemId);
  const authRecipePath = args.authRecipe || defaultAuthRecipePath(sessionPath);

  const byId = new Map(capabilityMap.capabilities.map((c) => [c.id || c.action, c]));

  async function run(capabilityId, params) {
    const capability = byId.get(capabilityId);
    if (!capability) return { ok: false, code: "UNKNOWN_CAPABILITY", capability: capabilityId };
    const contract = resolveCapabilityContract(capability, apiContracts);
    if (!contract) {
      // No learned API or compiled headless flow for this capability. Do not
      // ask the model to invent browser operations at runtime; surface the
      // missing learned-flow state so the user can re-run learning.
      return {
        ok: false,
        code: "NEEDS_LEARNED_FLOW",
        capability: capabilityId,
        message: "This capability has no learned API contract or compiled headless flow. Re-run learning for this action before normal use; runtime operation/script generation is disabled.",
      };
    }
    const plan = buildApiPlan(capability, contract, params);
    const confirmed = capability.risk && capability.risk !== "read";
    const runOpts = { storageState: sessionPath, authRecipe: authRecipePath, confirmed };
    let result = await runViaExecutor(draftDir, plan.action, plan, runOpts);
    // Self-heal an expired session ONCE: if the run went stale (the executor's own
    // refresh-endpoint retry didn't recover it) ask the main process to re-login
    // with a stored credential, then re-run. The password never reaches this child.
    if (result && result.ok === false && result.stale) {
      const failedUrl = result.failedOperation?.target || "";
      const relogin = await bridgeRelogin(failedUrl, sessionPath);
      if (relogin?.ok) result = await runViaExecutor(draftDir, plan.action, plan, runOpts);
    }
    return result;
  }

  const server = createWebSystemMcpServer({ systemId, systemName, capabilities: capabilityMap.capabilities, run });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
  process.exit(1);
});
