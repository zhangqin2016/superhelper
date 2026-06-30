#!/usr/bin/env node
/**
 * Built-in @playwright/mcp wiring must be a hard no-op until the platform bundle
 * actually ships node + @playwright/mcp + Chromium, and must emit a correct
 * --mcp-config (bundled node command, bundled browsers path, no host creds)
 * once it does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const {
  playwrightMcpAvailable,
  buildPlaywrightMcpConfig,
  buildFileIntelligenceMcpEntry,
  buildProcessJobsMcpEntry,
  buildToolBrokerMcpEntry,
  writeActiveMcpConfig,
} = require("../src/main/mcp-config.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mcp-cfg-"));
const isWin = process.platform === "win32";
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");

function makeBundle(root, { withBrowsers = true } = {}) {
  fs.mkdirSync(path.join(root, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node", "bin", isWin ? "node.exe" : "node"), "");
  fs.mkdirSync(path.join(root, "web", "node_modules", "@playwright", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "web", "node_modules", "@playwright", "mcp", "cli.js"), "");
  if (withBrowsers) fs.mkdirSync(path.join(root, "web", "browsers"), { recursive: true });
}

try {
  // absent bundle → no-op everywhere
  const empty = path.join(tmp, "empty");
  fs.mkdirSync(empty, { recursive: true });
  assert(playwrightMcpAvailable("") === false, "empty runtimeDir → unavailable");
  assert(playwrightMcpAvailable(empty) === false, "bundle without playwright → unavailable");
  assert(buildPlaywrightMcpConfig(empty) === null, "no config when bundle absent");
  const fileIntel = buildFileIntelligenceMcpEntry();
  assert(fileIntel.args[0].endsWith(path.join("mcp", "file-intelligence-mcp-stdio.js")), "file intelligence MCP launches stdio server");
  assert(fileIntel.env.ELECTRON_RUN_AS_NODE === "1", "file intelligence MCP runs through Electron node mode");
  const processJobs = buildProcessJobsMcpEntry();
  assert(processJobs.args[0].endsWith(path.join("mcp", "process-jobs-mcp-stdio.js")), "process jobs MCP launches stdio server");
  assert(processJobs.env.ELECTRON_RUN_AS_NODE === "1", "process jobs MCP runs through Electron node mode");
  const noBundleOut = path.join(tmp, "mcp-with-file-intel.json");
  const noBundleWrite = writeActiveMcpConfig(empty, noBundleOut);
  assert(noBundleWrite === noBundleOut && fs.existsSync(noBundleOut), "built-in Lily MCPs are available without runtime bundle");
  const noBundleCfg = JSON.parse(fs.readFileSync(noBundleOut, "utf8"));
  assert(noBundleCfg.mcpServers.lily_file_intelligence, "file intelligence MCP is always exposed");
  assert(noBundleCfg.mcpServers.lily_process_jobs, "process jobs MCP is always exposed");

  // present bundle → correct config
  const full = path.join(tmp, "full");
  makeBundle(full);
  assert(playwrightMcpAvailable(full) === true, "bundle with node + @playwright/mcp → available");
  const cfg = buildPlaywrightMcpConfig(full);
  assert(cfg && cfg.mcpServers && cfg.mcpServers.playwright, "playwright mcp server entry present");
  const server = cfg.mcpServers.playwright;
  assert(server.command.includes(path.join("node", "bin")), "command points at bundled node");
  assert(server.args[0].includes(path.join("@playwright", "mcp", "cli.js")), "args run the bundled mcp cli");
  assert(server.args.includes("--browser") && server.args.includes("chromium"), "uses bundled chromium");
  assert(server.args.includes("--headless") && server.args.includes("--isolated"), "headless + isolated profile");
  assert(server.env.PLAYWRIGHT_BROWSERS_PATH.includes(path.join("web", "browsers")), "browsers path points at bundled chromium");
  assert(!JSON.stringify(server).match(/authorization|cookie|password|token/i), "no credentials in the mcp config");

  // present node + mcp but no browsers dir → still configured, no browsers env
  const noBrowsers = path.join(tmp, "nob");
  makeBundle(noBrowsers, { withBrowsers: false });
  const cfg2 = buildPlaywrightMcpConfig(noBrowsers);
  assert(cfg2 && cfg2.mcpServers.playwright.env.PLAYWRIGHT_BROWSERS_PATH === undefined, "no browsers env when browsers dir absent");

  // write path
  const out = path.join(tmp, "mcp-active.json");
  const written = writeActiveMcpConfig(full, out);
  assert(written === out && fs.existsSync(out), "config written when bundle present");
  const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
  assert(parsed.mcpServers.playwright.command, "written config is valid JSON with the server");
  assert(parsed.mcpServers.lily_file_intelligence.command, "written config includes file intelligence server");
  assert(parsed.mcpServers.lily_process_jobs.command, "written config includes process jobs server");

  const learnedRoot = path.join(process.env.LILY_USER_DATA_DIR, "lily-config", "skills");
  const enabled = path.join(learnedRoot, "learned-enabled");
  const disabled = path.join(learnedRoot, "learned-disabled");
  for (const dir of [enabled, disabled]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "capability-map.json"), "{}");
    fs.writeFileSync(path.join(dir, "web-system-playbook.json"), "{}");
  }
  const scopedOut = path.join(tmp, "mcp-scoped.json");
  writeActiveMcpConfig(full, scopedOut, ["learned-enabled"]);
  const scoped = JSON.parse(fs.readFileSync(scopedOut, "utf8"));
  assert(scoped.mcpServers.web_learned_enabled, "active learned skill exposes its web-system MCP");
  assert(!scoped.mcpServers.web_learned_disabled, "disabled learned skill does not expose its web-system MCP");

  const prevBroker = process.env.LILY_TOOL_BROKER;
  const prevBrokerContext = process.env.LILY_TOOL_BROKER_CONTEXT;
  try {
    process.env.LILY_TOOL_BROKER = "1";
    process.env.LILY_TOOL_BROKER_CONTEXT = JSON.stringify({ sessionId: "s1", activeSkillIds: ["lily-runtime-packs"] });
    const brokerEntry = buildToolBrokerMcpEntry();
    assert(brokerEntry.args[0].endsWith(path.join("mcp", "tool-broker-stdio.js")), "broker entry launches the broker stdio server");
    assert(brokerEntry.env.LILY_TOOL_BROKER_CONTEXT.includes("lily-runtime-packs"), "broker entry carries explicit context when provided");
    const brokerOut = path.join(tmp, "mcp-broker.json");
    writeActiveMcpConfig(full, brokerOut, ["learned-enabled"]);
    const brokerCfg = JSON.parse(fs.readFileSync(brokerOut, "utf8"));
    assert(JSON.stringify(Object.keys(brokerCfg.mcpServers)) === JSON.stringify(["lily_tool_broker"]), "broker mode emits only the Lily broker");
  } finally {
    if (prevBroker === undefined) delete process.env.LILY_TOOL_BROKER;
    else process.env.LILY_TOOL_BROKER = prevBroker;
    if (prevBrokerContext === undefined) delete process.env.LILY_TOOL_BROKER_CONTEXT;
    else process.env.LILY_TOOL_BROKER_CONTEXT = prevBrokerContext;
  }

  console.log("PASS: test-mcp-config");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
