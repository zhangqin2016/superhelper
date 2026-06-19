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
const { playwrightMcpAvailable, buildPlaywrightMcpConfig, writeActiveMcpConfig } = require("../src/main/mcp-config.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mcp-cfg-"));
const isWin = process.platform === "win32";

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
  const noWrite = writeActiveMcpConfig(empty, path.join(tmp, "should-not-exist.json"));
  assert(noWrite === null && !fs.existsSync(path.join(tmp, "should-not-exist.json")), "no file written when bundle absent");

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

  console.log("PASS: test-mcp-config (16 tests)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
