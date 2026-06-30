"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const {
  listJobs,
  logsJob,
  startJob,
  statusJob,
  stopJob,
} = require("./process-jobs-core");

function asTextJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const healthcheckSchema = z.object({
  type: z.enum(["none", "process", "tcp", "http", "log"]).optional().describe("Health signal to verify the background job."),
  host: z.string().optional().describe("TCP host, default 127.0.0.1."),
  port: z.number().int().min(1).max(65535).optional().describe("TCP port."),
  url: z.string().optional().describe("HTTP health URL."),
  contains: z.string().optional().describe("Text expected in stdout/stderr logs."),
  timeoutMs: z.number().int().min(100).max(30_000).optional().describe("Per-probe timeout."),
  minStatus: z.number().int().min(100).max(599).optional().describe("Minimum accepted HTTP status."),
  maxStatus: z.number().int().min(100).max(599).optional().describe("Maximum accepted HTTP status."),
  tailBytes: z.number().int().min(1).max(1_000_000).optional().describe("Log bytes to inspect for log health."),
}).optional();

function createProcessJobsMcpServer(options = {}) {
  const server = new McpServer({ name: "lily-process-jobs", version: "1.0.0" });

  server.registerTool(
    "job_start",
    {
      description: "Start a long-running local process as a Lily-managed background job. Returns job id, pid, log paths, and optional health status; use for servers/watchers instead of ad-hoc shell detaching.",
      inputSchema: {
        command: z.string().describe("Command line to run."),
        args: z.array(z.string()).optional().describe("Arguments when command is an executable path. When provided and shell is omitted, the process starts without a shell."),
        cwd: z.string().optional().describe("Working directory. Defaults to the MCP process cwd."),
        env: z.record(z.string()).optional().describe("Additional environment variables."),
        jobId: z.string().optional().describe("Optional stable job id. Generated when omitted."),
        stdoutPath: z.string().optional().describe("Optional absolute stdout log path."),
        stderrPath: z.string().optional().describe("Optional absolute stderr log path."),
        shell: z.union([z.boolean(), z.string()]).optional().describe("Shell option for child_process.spawn. Defaults to true."),
        healthcheck: healthcheckSchema,
        waitForHealthMs: z.number().int().min(0).max(120_000).optional().describe("Wait up to this many ms for health before returning."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args) => asTextJson(await startJob(args || {}, options)),
  );

  server.registerTool(
    "job_status",
    {
      description: "Check a Lily-managed background job by id, including process liveness, log sizes, and health.",
      inputSchema: {
        jobId: z.string().describe("Job id returned by job_start."),
        healthcheck: healthcheckSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => asTextJson(await statusJob(args || {}, options)),
  );

  server.registerTool(
    "job_logs",
    {
      description: "Read stdout/stderr logs for a Lily-managed background job. Supports tail reads or explicit offsets.",
      inputSchema: {
        jobId: z.string().describe("Job id returned by job_start."),
        tailBytes: z.number().int().min(1).max(1_000_000).optional().describe("Bytes to tail when offsets are omitted."),
        stdoutOffset: z.number().int().min(0).optional().describe("Read stdout from this byte offset."),
        stderrOffset: z.number().int().min(0).optional().describe("Read stderr from this byte offset."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => asTextJson(logsJob(args || {}, options)),
  );

  server.registerTool(
    "job_stop",
    {
      description: "Stop a Lily-managed background job by pid, using SIGTERM then SIGKILL unless force is false.",
      inputSchema: {
        jobId: z.string().describe("Job id returned by job_start."),
        signal: z.string().optional().describe("Signal to send first, default SIGTERM."),
        timeoutMs: z.number().int().min(100).max(60_000).optional().describe("Wait before force kill."),
        force: z.boolean().optional().describe("Whether to force kill after timeout. Defaults to true."),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => asTextJson(await stopJob(args || {}, options)),
  );

  server.registerTool(
    "job_list",
    {
      description: "List recent Lily-managed background jobs.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => asTextJson(listJobs(args || {}, options)),
  );

  return server;
}

module.exports = {
  asTextJson,
  createProcessJobsMcpServer,
};
