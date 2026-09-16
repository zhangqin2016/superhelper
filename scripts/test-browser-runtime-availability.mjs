#!/usr/bin/env node
/**
 * Browser automation availability and runtime pairing.
 *
 * Acceptance 2026-09-16 DEF-004: the web-automation pack reported
 * installed/ready/healthy while the tool broker answered
 * BROWSER_RUNTIME_UNAVAILABLE for browser_open. The pack ships @playwright/mcp,
 * playwright and the browsers but no interpreter, and playwright resolution bailed
 * out before ever looking at the pack when the base bundle had no node/ directory.
 * The app binary is itself a Node interpreter in ELECTRON_RUN_AS_NODE mode.
 *
 * Acceptance 2026-09-16 DEF-005: the module tree and the browser directory came
 * from different installations — a playwright that wanted chromium build 1217
 * beside a pack that shipped 1228. They must move as one set.
 *
 * [gate: browser-runtime-availability]
 * Run: node scripts/test-browser-runtime-availability.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-browser-runtime-"));
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");

function makePack(dir) {
  fs.mkdirSync(path.join(dir, "node_modules", "@playwright", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "@playwright", "mcp", "cli.js"), "");
  fs.mkdirSync(path.join(dir, "node_modules", "playwright"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright" }));
  fs.mkdirSync(path.join(dir, "browsers"), { recursive: true });
  return dir;
}

try {
  const { buildPlaywrightMcpConfig, playwrightMcpAvailable } = require(path.join(ROOT, "src/main/mcp-config.js"));

  const pack = makePack(path.join(tmp, "web-automation"));
  const bundleWithoutNode = path.join(tmp, "bundle-no-node");
  fs.mkdirSync(bundleWithoutNode, { recursive: true });

  check("an installed pack alone activates browser automation, using the app binary as Node", () => {
    const config = buildPlaywrightMcpConfig(bundleWithoutNode, { webAutomationPackDir: pack });
    const server = config?.mcpServers?.playwright;
    assert.ok(server, "a healthy pack must not report the browser runtime as unavailable");
    assert.equal(server.command, process.execPath, "the app binary is the interpreter");
    assert.equal(server.env.ELECTRON_RUN_AS_NODE, "1", "launching it as Node needs the mode flag");
    assert.equal(server.args[0], path.join(pack, "node_modules", "@playwright", "mcp", "cli.js"));
    assert.equal(server.env.PLAYWRIGHT_BROWSERS_PATH, path.join(pack, "browsers"));
    assert.equal(server.env.NODE_PATH, path.join(pack, "node_modules"), "modules are pinned to the pack the cli came from");
    assert.ok(!/authorization|cookie|password|token/i.test(JSON.stringify(server)), "no credentials in the config");
  });

  check("a bundled Node still wins over the app binary, and nothing anywhere is still a clean no-op", () => {
    const bundle = path.join(tmp, "bundle-with-node");
    fs.mkdirSync(path.join(bundle, "node", "bin"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "node", "bin", isWin ? "node.exe" : "node"), "");
    fs.mkdirSync(path.join(bundle, "web", "node_modules", "@playwright", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "web", "node_modules", "@playwright", "mcp", "cli.js"), "");
    const server = buildPlaywrightMcpConfig(bundle).mcpServers.playwright;
    assert.ok(server.command.includes(path.join("node", "bin")), "the bundled interpreter is preferred");
    assert.equal(server.env.ELECTRON_RUN_AS_NODE, undefined, "a real node binary needs no mode flag");

    const nothing = path.join(tmp, "bundle-empty");
    fs.mkdirSync(nothing, { recursive: true });
    assert.equal(playwrightMcpAvailable(nothing), false);
    assert.equal(buildPlaywrightMcpConfig(nothing), null);
    assert.equal(playwrightMcpAvailable(""), false);
    assert.equal(buildPlaywrightMcpConfig(nothing, { webAutomationPackDir: path.join(tmp, "not-a-pack") }), null);
  });

  check("the playwright module tree and browser directory always come from ONE installation", () => {
    // A base bundle that ships its own web runtime, AND an installed pack. The
    // pack must win whole — never the bundle's modules beside the pack's browsers.
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "lily-browser-res-"));
    process.resourcesPath = resources;
    const key = process.platform === "darwin"
      ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
      : (isWin ? "win32-x64" : "linux-x64");
    const runtimeRoot = path.join(resources, "bundles", key, "runtime");
    const bundleModules = path.join(runtimeRoot, "web", "node_modules");
    const bundleBrowsers = path.join(runtimeRoot, "web", "browsers");
    fs.mkdirSync(path.join(runtimeRoot, "node", "bin"), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "node", "bin", isWin ? "node.exe" : "node"), "");
    fs.mkdirSync(path.join(bundleModules, "playwright"), { recursive: true });
    fs.writeFileSync(path.join(bundleModules, "playwright", "package.json"), JSON.stringify({ name: "playwright" }));
    fs.mkdirSync(bundleBrowsers, { recursive: true });

    const packsRoot = path.join(tmp, "bundled-packs");
    makePack(path.join(packsRoot, "web-automation"));
    process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS = packsRoot;

    const electronPath = require.resolve("electron");
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        app: {
          isPackaged: true,
          getPath: (name) => (name === "userData" ? path.join(resources, "user-data") : os.tmpdir()),
        },
      },
    };
    const { buildAgentSpawnEnv } = require(path.join(ROOT, "src/main/spawn-env.js"));
    const env = buildAgentSpawnEnv();
    const packModules = path.join(packsRoot, "web-automation", "node_modules");
    const packBrowsers = path.join(packsRoot, "web-automation", "browsers");
    assert.equal(env.LILY_PLAYWRIGHT_NODE_MODULES, packModules, "the pack supplies the module tree");
    assert.equal(env.NODE_PATH, packModules, "NODE_PATH must not fall back to the bundle's older playwright");
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, packBrowsers, "browsers come from the same installation");
    assert.notEqual(env.NODE_PATH, bundleModules);

    delete process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS;
    fs.rmSync(resources, { recursive: true, force: true });
  });

  console.log(`\n${checks} checks passed (browser runtime availability)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
