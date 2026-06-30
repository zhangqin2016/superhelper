"use strict";

const PROCESS_JOB_PROTOCOL_MARKER = "## Process Job Protocol";

const PROCESS_JOB_PROTOCOL_GUIDANCE = [
  PROCESS_JOB_PROTOCOL_MARKER,
  "",
  "For long-running local services, dev servers, watchers, or commands that would otherwise be detached with Start-Process, nohup, &, disown, or a new terminal, prefer the lily_process_jobs MCP tools.",
  "Use job_start with an explicit cwd and, when possible, a healthcheck (process, tcp, http, or log). Then use job_status and job_logs to verify startup before claiming success. Use job_stop when the user asks to stop a managed job.",
  "Do not claim a background service is started unless job_start/job_status returns a pid plus a passing health signal or clear log evidence. If health is not configured, say that only process liveness was verified.",
  "If the Lily process jobs tool is unavailable or fails, fall back to normal foreground shell behavior without blocking the task; do not invent job status from detached shell text.",
].join("\n");

function appendProcessJobProtocolGuidance(guide) {
  const base = String(guide || "").trim();
  if (base.includes(PROCESS_JOB_PROTOCOL_MARKER)) return base;
  return [base, PROCESS_JOB_PROTOCOL_GUIDANCE].filter(Boolean).join("\n\n");
}

module.exports = {
  PROCESS_JOB_PROTOCOL_GUIDANCE,
  appendProcessJobProtocolGuidance,
};
