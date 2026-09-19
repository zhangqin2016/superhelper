"use strict";

/**
 * Built-in @playwright/mcp wiring.
 *
 * When the platform runtime bundle ships node + @playwright/mcp (Chromium is
 * optional — falls back to the user's Chrome; see docs/playwright-builtin-plan.md),
 * this module emits the MCP config that registers the Playwright MCP server with
 * the active engine (OpenCode today; the entry is engine-agnostic and consumed
 * via SessionRunnerPool._opencodeMcpServers), so the model can drive a browser
 * via the accessibility tree.
 *
 * Everything here is gated on the bundle actually being present: if node or the
 * @playwright/mcp entry is missing, every function returns null and the engine
 * spawn adds no `--mcp-config` — a hard no-op until the new bundle ships. That
 * keeps current builds (no bundled browser runtime) completely unaffected.
 *
 * Expected bundle layout under <runtimeDir> (built by build-runtime-bundle.mjs):
 *   node/bin/node            (node binary; node.exe on win32)
 *   web/node_modules/@playwright/mcp/cli.js
 *   web/node_modules/playwright (used by execute_web_playbook.cjs too)
 *   web/browsers/            (PLAYWRIGHT_BROWSERS_PATH — bundled Chromium)
 */

const fs = require("node:fs");
const jsonFile = require("./json-file");
const path = require("node:path");

function nodeBinaryPath(runtimeDir) {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const candidate = path.join(runtimeDir, "node", "bin", exe);
  // Windows node-build-standalone puts node.exe at the root, not under bin.
  const winRoot = path.join(runtimeDir, "node", exe);
  if (fs.existsSync(candidate)) return candidate;
  if (fs.existsSync(winRoot)) return winRoot;
  return "";
}

function playwrightMcpEntry(runtimeDir) {
  return path.join(runtimeDir, "web", "node_modules", "@playwright", "mcp", "cli.js");
}

function bundledBrowsersDir(runtimeDir) {
  return path.join(runtimeDir, "web", "browsers");
}

function bundledNodeModulesDir(runtimeDir) {
  return path.join(runtimeDir, "web", "node_modules");
}

// The app binary IS a Node interpreter in ELECTRON_RUN_AS_NODE mode — four other
// built-in MCP servers already launch through it. So a build whose base bundle
// ships no node/ directory does not have to disable browser automation: an
// installed Web Automation pack carries @playwright/mcp, playwright and the
// browsers, and only ever lacked an interpreter. Acceptance 2026-09-16 DEF-004:
// the pack self-reported installed/ready/healthy while the broker answered
// BROWSER_RUNTIME_UNAVAILABLE, because this guard returned before the pack was
// ever consulted. [gate: browser-runtime-availability]
function resolveNodeCommand(runtimeDir) {
  const bundled = runtimeDir ? nodeBinaryPath(runtimeDir) : "";
  if (bundled) return { command: bundled, runAsNode: false };
  if (process.execPath) return { command: process.execPath, runAsNode: true };
  return null;
}

function resolvePlaywrightRuntime(runtimeDir, { webAutomationPackDir = "" } = {}) {
  const node = resolveNodeCommand(runtimeDir);
  if (!node) return null;

  if (webAutomationPackDir) {
    const nodeModulesPath = path.join(webAutomationPackDir, "node_modules");
    const cliPath = path.join(nodeModulesPath, "@playwright", "mcp", "cli.js");
    if (fs.existsSync(cliPath)) {
      return {
        ...node,
        cliPath,
        nodeModulesPath,
        browsersPath: path.join(webAutomationPackDir, "browsers"),
        source: "web-automation-pack",
      };
    }
  }

  if (!runtimeDir) return null;
  const cliPath = playwrightMcpEntry(runtimeDir);
  if (!fs.existsSync(cliPath)) return null;
  return {
    ...node,
    cliPath,
    nodeModulesPath: bundledNodeModulesDir(runtimeDir),
    browsersPath: bundledBrowsersDir(runtimeDir),
    source: "base-runtime",
  };
}

/** True only when the bundle actually carries node + @playwright/mcp. */
function playwrightMcpAvailable(runtimeDir, options) {
  return Boolean(resolvePlaywrightRuntime(runtimeDir, options));
}

/**
 * The engine MCP config document, or null when the bundle is absent.
 * @param {string} runtimeDir
 */
function buildPlaywrightMcpConfig(runtimeDir, options) {
  const resolved = resolvePlaywrightRuntime(runtimeDir, options);
  if (!resolved) return null;
  const browsers = resolved.browsersPath;
  const hasBundledChromium = fs.existsSync(browsers);
  const env = {};
  if (hasBundledChromium) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  // Launching the app binary as Node needs the mode flag.
  if (resolved.runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  // Pin module resolution to the SAME installation the cli came from. Without
  // this the server inherits whatever NODE_PATH the engine was spawned with and
  // can load a different playwright than the browsers beside it were built for.
  if (resolved.nodeModulesPath && fs.existsSync(resolved.nodeModulesPath)) {
    env.NODE_PATH = resolved.nodeModulesPath;
  }
  // Always chromium. The old fallback passed "chrome", which @playwright/mcp
  // resolves to chrome-for-testing — a browser nobody has installed — so the
  // failure read as "Browser chrome-for-testing is not installed. Run npx
  // @playwright/mcp install-browser", which is neither true nor actionable.
  // Acceptance 2026-09-17 P29. With no bundled browsers we simply leave
  // PLAYWRIGHT_BROWSERS_PATH unset and let Playwright use its own cache, which
  // is where a developer machine's Chromium already lives.
  const browserArg = "chromium";
  return {
    mcpServers: {
      playwright: {
        command: resolved.command,
        // Headless, isolated profile; never reuse credentials from the host —
        // the model logs in interactively when needed.
        args: [resolved.cliPath, "--browser", browserArg, "--headless", "--isolated"],
        env,
      },
    },
  };
}

/**
 * Write the active MCP config to disk and return its path, or null if the
 * bundle is absent (caller then adds no --mcp-config).
 * @param {string} runtimeDir
 * @param {string} outPath
 */

/**
 * The mail connector MCP server entry, or null when the connector bridge isn't
 * running. Launched via the app binary in node mode (ELECTRON_RUN_AS_NODE) so it
 * can require the bundled MCP SDK; it proxies to the bridge for credentials.
 */
function buildMailMcpEntry() {
  let env;
  try {
    env = require("./connector-bridge").getConnectorBridgeEnvSync();
  } catch {
    return null;
  }
  if (!env?.LILY_CONNECTOR_BRIDGE_URL || !env?.LILY_CONNECTOR_BRIDGE_TOKEN) return null;
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp", "mail-mcp-stdio.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", ...env },
  };
}

/**
 * Lily tool broker entry. With LILY_TOOL_BROKER_CONTEXT it exposes session-
 * scoped tools; without context it exposes only platform-level capability and
 * runtime-pack tools.
 * @param {object | undefined} context Explicit session context. Undefined keeps
 * the legacy process-environment fallback for external callers.
 */
function buildToolBrokerMcpEntry(context, options = {}) {
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  // The child env is a fresh object (not a copy of process.env), so the
  // Character Worlds emergency kill switch must be forwarded explicitly —
  // otherwise LILY_CHARACTER_WORLDS=0 would not reach the broker subprocess
  // and an injected enabled context could not be overridden.
  if (process.env.LILY_CHARACTER_WORLDS === "0") {
    env.LILY_CHARACTER_WORLDS = "0";
  }
  let serializedContext = "";
  if (context !== undefined) {
    try {
      serializedContext = JSON.stringify(context) || "";
    } catch {
      // Explicit malformed context fails closed to platform-level broker tools;
      // never borrow another session's process-global compatibility context.
      serializedContext = "";
    }
  } else if (process.env.LILY_TOOL_BROKER_CONTEXT) {
    // Compatibility for older/external callers that have not moved to the
    // explicit fourth writeActiveMcpConfig argument yet.
    serializedContext = process.env.LILY_TOOL_BROKER_CONTEXT;
  }
  if (serializedContext) {
    env.LILY_TOOL_BROKER_CONTEXT = serializedContext;
  }
  const runtimeIdentity = options.runtimeIdentity;
  if (
    process.env.LILY_RUNTIME_IDENTITY_V1 !== "0" &&
    runtimeIdentity?.secret &&
    runtimeIdentity?.registryPath
  ) {
    env.LILY_RUNTIME_IDENTITY_V1 = "1";
    env.LILY_RUNTIME_IDENTITY_SECRET = String(runtimeIdentity.secret);
    env.LILY_RUNTIME_IDENTITY_REGISTRY = String(runtimeIdentity.registryPath);
  }
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp", "tool-broker-stdio.js")],
    env,
  };
}

/** Built-in file intelligence MCP: inspect/sample/extract large local inputs
 * without forcing them into model context. It is deliberately always available
 * because it runs through the app's own Node runtime and fails open in tool
 * responses rather than blocking OpenCode startup. */
function buildFileIntelligenceMcpEntry() {
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp", "file-intelligence-mcp-stdio.js")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/** Built-in process job MCP: gives the agent a structured path for long-running
 * local servers/watchers without changing OpenCode's foreground Bash behavior. */
function buildProcessJobsMcpEntry(options = {}) {
  let durableEnv = {};
  try {
    const config = require("./config");
    durableEnv = {
      LILY_LONG_TASK_DB: options.longTaskDbPath || config.longTaskDbPath(),
      LILY_PROCESS_JOBS_SCOPE_SECRET: options.scopeSecret
        || require("./long-task/secret").ensureLongTaskSecret(),
    };
  } catch {
    durableEnv = {};
  }
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp", "process-jobs-mcp-stdio.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", ...durableEnv },
  };
}

/** MCP server entry for one learned web system (its capabilities as typed tools). */
function webSystemMcpEntry(draftDir) {
  if (
    !draftDir ||
    !fs.existsSync(path.join(draftDir, "capability-map.json")) ||
    !fs.existsSync(path.join(draftDir, "web-system-playbook.json"))
  ) {
    return null;
  }
  // Pass the connector-bridge env (optional) so the child can ask the MAIN process
  // to auto re-login a stale session (#1b). Absent => the web system still works,
  // it just can't self-heal an expired session.
  let bridgeEnv = {};
  try {
    bridgeEnv = require("./connector-bridge").getConnectorBridgeEnvSync() || {};
  } catch {
    bridgeEnv = {};
  }
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp", "web-system-mcp-stdio.js"), "--system", draftDir],
    env: { ELECTRON_RUN_AS_NODE: "1", ...bridgeEnv },
  };
}

function serverNameForSystem(draftDir) {
  const base = path.basename(String(draftDir || "")).replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return `web_${base || "system"}`.slice(0, 64);
}

/** Installed learned skills that carry a web-system playbook (one per system).
 *  `allowedSkillIds` (when provided) scopes this to the skills ACTIVE for the
 *  current session — a learned workspace skill the user disabled / did not select
 *  must not expose its web-system MCP tools, otherwise the assistant "sees" a
 *  connected system the skills panel shows as off and offers to operate it.
 *  Null (e.g. tests / no session) keeps the old behavior of returning all. */
function learnedWebSystemDirs(allowedSkillIds = null) {
  try {
    const { agentConfigDir } = require("./config");
    const root = path.join(agentConfigDir(), "skills");
    const allow = allowedSkillIds ? new Set(allowedSkillIds) : null;
    return fs
      .readdirSync(root)
      .filter((name) => name.startsWith("learned-"))
      .filter((name) => !allow || allow.has(name))
      .map((name) => path.join(root, name))
      .filter((dir) => fs.existsSync(path.join(dir, "web-system-playbook.json")));
  } catch {
    return [];
  }
}

/** {serverName: entry} for the given learned-system dirs. */
function buildWebSystemMcpEntries(systemDirs) {
  const out = {};
  for (const dir of Array.isArray(systemDirs) ? systemDirs : []) {
    const entry = webSystemMcpEntry(dir);
    if (entry) out[serverNameForSystem(dir)] = entry;
  }
  return out;
}

function writeActiveMcpConfig(runtimeDir, outPath, allowedSkillIds = null, context, options = {}) {
  const mcpServers = {};
  const playwright = runtimeDir ? buildPlaywrightMcpConfig(runtimeDir, options) : null;
  if (playwright?.mcpServers) Object.assign(mcpServers, playwright.mcpServers);
  let brokerContext = context;
  if (context !== undefined && context && typeof context === "object" && !Array.isArray(context)) {
    brokerContext = { ...context };
    if (!Array.isArray(brokerContext.activeSkillIds) && Array.isArray(allowedSkillIds)) {
      brokerContext.activeSkillIds = allowedSkillIds;
    }
    brokerContext.runtime = {
      ...(context.runtime || {}),
      browserAvailable: Boolean(playwright?.mcpServers?.playwright),
    };
  }
  mcpServers.lily_tool_broker = buildToolBrokerMcpEntry(brokerContext, options);
  mcpServers.lily_file_intelligence = buildFileIntelligenceMcpEntry();
  mcpServers.lily_process_jobs = buildProcessJobsMcpEntry(options.processJobs || {});
  const mail = buildMailMcpEntry();
  if (mail) mcpServers.mail = mail;
  // Each learned web system becomes its own MCP server (typed tools), but only
  // for the learned skills active in this session — see learnedWebSystemDirs.
  Object.assign(mcpServers, buildWebSystemMcpEntries(learnedWebSystemDirs(allowedSkillIds)));
  if (!Object.keys(mcpServers).length) return null;
  // Rebuilt on every runner ensure — including the write-free warm-up after a
  // session switch — so the file is only replaced when its content moved.
  jsonFile.writeJson(outPath, { mcpServers }, { newline: true, onlyIfChanged: true });
  return outPath;
}

module.exports = {
  nodeBinaryPath,
  playwrightMcpEntry,
  buildMailMcpEntry,
  buildFileIntelligenceMcpEntry,
  buildProcessJobsMcpEntry,
  buildToolBrokerMcpEntry,
  bundledBrowsersDir,
  bundledNodeModulesDir,
  resolvePlaywrightRuntime,
  playwrightMcpAvailable,
  buildPlaywrightMcpConfig,
  webSystemMcpEntry,
  buildWebSystemMcpEntries,
  learnedWebSystemDirs,
  writeActiveMcpConfig,
};
