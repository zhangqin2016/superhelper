#!/usr/bin/env node

import { createRequire } from "node:module";
import { assert, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  PROCESS_JOB_PROTOCOL_GUIDANCE,
  appendProcessJobProtocolGuidance,
} = require("../src/main/process-job-protocol.js");

{
  const guide = appendProcessJobProtocolGuidance("Base guide");
  assert(guide.includes("Base guide"), "existing guide is preserved");
  assert(guide.includes("## Process Job Protocol"), "process job protocol is appended");
  assert(guide.includes("lily_process_jobs"), "guidance names the MCP server");
  assert(guide.includes("fall back to normal foreground shell behavior"), "guidance preserves fail-open behavior");
}

{
  const once = appendProcessJobProtocolGuidance(PROCESS_JOB_PROTOCOL_GUIDANCE);
  const twice = appendProcessJobProtocolGuidance(once);
  assert(once === twice, "protocol guidance is idempotent");
}

finish("test-process-job-protocol", 2);
