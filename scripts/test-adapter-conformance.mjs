#!/usr/bin/env node
// Runs the engine-agnostic adapter exam against the Claude CLI adapter using
// every recorded fixture as the transcript. A future QwenCodeAdapter passes
// the SAME exam with its own fixtures before going behind AgentSession.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runAdapterConformance } from "./adapter-conformance.mjs";

const require = createRequire(import.meta.url);
const { CliEventAdapter } = require("../src/main/runtime/adapters/claude-cli-adapter.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "fixtures/claude-runtime");

const transcript = [];
for (const file of fs.readdirSync(fixtureDir)) {
  if (!file.endsWith(".jsonl")) continue;
  for (const line of fs.readFileSync(path.join(fixtureDir, file), "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      transcript.push(JSON.parse(trimmed));
    } catch {
      // comment lines in fixtures
    }
  }
}
if (transcript.length < 20) {
  throw new Error(`expected fixture transcript events, got ${transcript.length}`);
}

const result = runAdapterConformance(new CliEventAdapter(), transcript);
if (!result.ok) {
  console.error("adapter conformance FAILED:\n" + result.failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(
  `adapter-conformance: ok (claude-cli, ${result.stats.transcriptEvents} events, ` +
  `${result.stats.drafts} drafts, ${result.stats.warnings} warnings)`,
);
