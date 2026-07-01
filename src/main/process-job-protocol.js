"use strict";

const PROCESS_JOB_PROTOCOL_MARKER = "## Process Job Protocol";

const PROCESS_JOB_PROTOCOL_GUIDANCE = [
  PROCESS_JOB_PROTOCOL_MARKER,
  "",
  "The agent runtime remains the engine of record. Process jobs are only a Lily supervisor for long-lived external processes and measurable long-running local work; they do not replace normal tool execution or model reasoning.",
  "Do not route short foreground commands through process jobs. Quick read/glob/grep/list/ls/find/search calls, small one-shot shell commands, and ordinary verification commands should stay on the normal foreground tool path.",
  "For long-running local services, dev servers, watchers, or commands that would otherwise be detached with Start-Process, nohup, &, disown, or a new terminal, prefer the lily_process_jobs MCP tools.",
  "Use job_start with an explicit cwd and, when possible, a healthcheck (process, tcp, http, or log). Then use job_status and job_logs to verify startup before claiming success. Use job_stop when the user asks to stop a managed job.",
  "Skills may emit one-line JSON progress markers to stdout or stderr as `[lily-progress] {\"label\":\"...\",\"current\":1,\"total\":10,\"domain\":\"...\"}`. Skills must not define their own progress protocol or require host-side special cases; observe progress through job_status/job_logs.",
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
