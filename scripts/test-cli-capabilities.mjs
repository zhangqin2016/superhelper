#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseCliVersion,
  versionAtLeast,
  capabilitiesForVersion,
} = require("../src/main/cli-capabilities.js");
const { CliEventAdapter } = require("../src/main/runtime/adapters/claude-cli-adapter.js");

const v2165 = parseCliVersion("2.1.165 (Claude Code)");
if (v2165?.major !== 2 || v2165?.minor !== 1 || v2165?.patch !== 165) {
  throw new Error(`parseCliVersion failed: ${JSON.stringify(v2165)}`);
}
if (versionAtLeast(v2165, 2, 1, 169)) {
  throw new Error("2.1.165 must not advertise 2.1.169 capabilities");
}

const v2177 = parseCliVersion("2.1.177 (Claude Code)");
const caps = capabilitiesForVersion(v2177);
for (const key of ["streamInput", "emitsThinking", "hotEnvUpdate", "permissionControl", "resume"]) {
  if (caps[key] !== true) throw new Error(`core capability missing: ${key}`);
}
if (!caps.safeMode || !caps.fableModelAlias || !caps.rateLimitEvent) {
  throw new Error(`2.1.177 capability flags wrong: ${JSON.stringify(caps)}`);
}

const oldCaps = capabilitiesForVersion(v2165);
if (oldCaps.safeMode || oldCaps.fableModelAlias || oldCaps.rateLimitEvent) {
  throw new Error(`2.1.165 should not claim new capabilities: ${JSON.stringify(oldCaps)}`);
}

const adapter = new CliEventAdapter({
  cliVersion: v2177,
  versionText: "2.1.177 (Claude Code)",
  capabilities: caps,
});
if (adapter.versionText !== "2.1.177 (Claude Code)" || adapter.capabilities.rateLimitEvent !== true) {
  throw new Error(`adapter did not retain CLI capability metadata: ${JSON.stringify(adapter.capabilities)}`);
}

console.log("cli-capabilities: ok");
