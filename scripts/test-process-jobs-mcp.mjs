#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assert, assertEqual, finish } from "./lib/test-assert.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-process-jobs-mcp-"));

function parseToolText(result) {
  const text = result?.content?.find?.((item) => item.type === "text")?.text || "";
  return JSON.parse(text);
}

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

const client = new Client({ name: "process-jobs-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), "src/main/mcp/process-jobs-mcp-stdio.js")],
  env: { ...process.env, LILY_PROCESS_JOBS_DIR: tmp },
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assertEqual(
    tools.map((tool) => tool.name).sort(),
    ["job_list", "job_logs", "job_start", "job_status", "job_stop"],
    "process jobs MCP exposes the full job protocol",
  );

  const started = parseToolText(await client.callTool({
    name: "job_start",
    arguments: {
      command: nodeCommand("console.log('mcp-ready'); console.log('[lily-progress] {\"label\":\"mcp-index\",\"current\":3,\"total\":4,\"domain\":\"mcp\"}'); setInterval(() => console.log('mcp-tick'), 1000);"),
      cwd: tmp,
      healthcheck: { type: "log", contains: "mcp-ready" },
      waitForHealthMs: 5_000,
    },
  }));
  assert(started.ok === true && started.pid > 0, `job_start returns a managed process: ${JSON.stringify(started)}`);
  assert(started.health?.ok === true, `job_start reports health evidence: ${JSON.stringify(started.health)}`);

  const status = parseToolText(await client.callTool({
    name: "job_status",
    arguments: { jobId: started.jobId, healthcheck: { type: "process" } },
  }));
  assert(status.ok === true && status.alive === true, `job_status observes the managed process: ${JSON.stringify(status)}`);
  assert(status.progress?.label === "mcp-index" && status.progress?.current === 3, `job_status exposes progress: ${JSON.stringify(status.progress)}`);

  const logs = parseToolText(await client.callTool({
    name: "job_logs",
    arguments: { jobId: started.jobId, tailBytes: 10_000 },
  }));
  assert(logs.ok === true && logs.stdout.text.includes("mcp-ready"), `job_logs returns stdout evidence: ${JSON.stringify(logs)}`);
  assert(logs.progress?.domain === "mcp", `job_logs exposes parsed progress: ${JSON.stringify(logs.progress)}`);

  const stopped = parseToolText(await client.callTool({
    name: "job_stop",
    arguments: { jobId: started.jobId, timeoutMs: 2_000 },
  }));
  assert(stopped.ok === true && stopped.stopped === true, `job_stop stops the process: ${JSON.stringify(stopped)}`);

  await client.close();
  finish("test-process-jobs-mcp", 5);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
