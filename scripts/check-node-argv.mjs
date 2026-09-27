#!/usr/bin/env node
/**
 * Does the `node` on PATH hand a script its arguments the way Node does?
 *
 * Electron running as Node (Lily's own `node` shim) reports
 * process.versions.electron, and yargs/commander then treat argv as a packaged
 * Electron app's: the script path arrives as an argument. electron-builder
 * refuses it ("Unknown argument: …/.bin/electron-builder") — after the runtime
 * bundle has already been built (2026-09-27, release 0.1.189 attempt 3).
 * Checked first, in seconds, with the parser electron-builder itself uses.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PROBE = ["--probe-flag", "probe-value"];

if (process.argv[2] === "--child") {
  const require = createRequire(import.meta.url);
  const { hideBin } = require("yargs/helpers");
  process.stdout.write(JSON.stringify({
    parsed: hideBin(process.argv),
    electron: process.versions.electron || "",
    defaultApp: Boolean(process.defaultApp),
  }));
  process.exit(0);
}

const result = spawnSync("node", [fileURLToPath(import.meta.url), "--child", ...PROBE], { encoding: "utf8" });
let probe = null;
try { probe = JSON.parse(result.stdout || ""); } catch { /* reported below */ }
const expected = JSON.stringify(["--child", ...PROBE]);
if (!probe || JSON.stringify(probe.parsed) !== expected) {
  console.error(`[check-node-argv] the node on PATH misreads CLI arguments: got ${probe ? JSON.stringify(probe.parsed) : `no result (${result.error?.message || result.stderr || `exit ${result.status}`})`}, expected ${expected}.`);
  if (probe?.electron) {
    console.error(`[check-node-argv] it is Electron ${probe.electron} running as Node without process.defaultApp — an older Lily node shim. Restart Lily (the shim is rewritten on start) or put a real Node first on PATH.`);
  }
  process.exit(1);
}
console.log(`[check-node-argv] ok (${probe.electron ? `Electron ${probe.electron} as Node, argv-compatible` : "Node"})`);
