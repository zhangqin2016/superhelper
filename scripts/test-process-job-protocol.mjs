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
  assert(guide.includes("[lily-progress]"), "guidance documents the platform progress protocol");
  assert(guide.includes("job_status") && guide.includes("job_logs"), "guidance routes progress observation through generic job status/logs");
  assert(guide.includes("fall back to normal foreground shell behavior"), "guidance preserves fail-open behavior");
  assert(guide.includes("The agent runtime remains the engine of record"), "guidance keeps process jobs as a supervisor, not an engine replacement");
  assert(guide.includes("Do not route short foreground commands"), "guidance keeps quick work on the normal tool path");
  assert(guide.includes("Skills may emit") && guide.includes("must not define their own progress protocol"),
    "guidance prevents skill-specific progress protocols");
  assert(!/matrx|web-system-learning|stock|pdf extraction/i.test(guide),
    "protocol guidance stays domain-neutral and skill-agnostic");
}

{
  const once = appendProcessJobProtocolGuidance(PROCESS_JOB_PROTOCOL_GUIDANCE);
  const twice = appendProcessJobProtocolGuidance(once);
  assert(once === twice, "protocol guidance is idempotent");
}

finish("test-process-job-protocol", 6);
