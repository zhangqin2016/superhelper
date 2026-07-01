#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { assert, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runner-guidance-"));
const configDir = path.join(tmp, "session-guide");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, "AGENT.md"), "BASE SESSION GUIDE\n", "utf8");

try {
  const pool = new SessionRunnerPool();
  const guide = pool._opencodeGuideContent(configDir, "session_1");
  assert(guide.startsWith("BASE SESSION GUIDE"), "session AGENT.md content remains first");
  assert(guide.includes("## Large Input Protocol"), "large input protocol is included");
  assert(guide.includes("## Process Job Protocol"), "process job protocol is included");
  assert(guide.includes("lily_process_jobs"), "process job MCP guidance is included");
  assert(guide.includes("fall back to normal foreground shell behavior"), "process job guidance is fail-open");
  assert(guide.includes("The agent runtime remains the engine of record"), "guidance preserves the engine boundary");
  assert(guide.includes("Do not route short foreground commands"), "guidance does not make quick commands slower");
  finish("test-session-runner-guidance-protocols", 7);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
