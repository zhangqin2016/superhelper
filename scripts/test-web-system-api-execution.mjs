#!/usr/bin/env node
/**
 * The product expectation: after login, an all-API action must run over plain
 * HTTP with the reused session — NO browser launch (and no Playwright needed).
 * Previously every action, even a pure API call, launched a browser. This pins
 * the browser-free API fast path against a real local server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const executor = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/execute_web_playbook.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-api-exec-"));

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/leaves")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: 1, days: 2 }]));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Async spawn so the in-process HTTP server keeps serving while the executor runs
// (spawnSync would block this event loop and the server could never respond).
function runExecutor(playbookPath, planPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executor, "--playbook", playbookPath, "--action", "web.query-leaves", "--plan", planPath], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;

  const playbookPath = path.join(tmp, "playbook.json");
  fs.writeFileSync(playbookPath, JSON.stringify({
    schemaVersion: 1,
    id: "demo",
    baseUrl: base,
    allowedDomains: ["127.0.0.1"],
    apiContracts: [{ id: "list-leaves", method: "GET", endpoint: `${base}api/leaves`, risk: "read", contentType: "query" }],
    actions: [{ action: "web.query-leaves", title: "Query leaves", risk: "read", confirmation: "none", metadata: { apiContractRefs: ["list-leaves"] } }],
  }));

  const planPath = path.join(tmp, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify({
    action: "web.query-leaves",
    operations: [{ type: "apiRequest", contractId: "list-leaves", method: "GET", risk: "read" }],
  }));

  // Real run (not dry-run). A read action needs no confirmation.
  const result = await runExecutor(playbookPath, planPath);
  assert(result.code === 0, `executor should succeed: ${result.stderr || result.stdout}`);
  const out = JSON.parse(result.stdout);

  assert(out.ok === true, `API action should succeed, got ${JSON.stringify(out)}`);
  // Proves the browser-free path was taken (not runBrowser, which would need Playwright).
  assert(out.transport === "http", `must run over HTTP, not a browser; got transport=${out.transport}`);
  assert(out.code !== "PLAYWRIGHT_NODE_MISSING", "must not require a browser runtime for an API action");
  assert(Array.isArray(out.apiResponses) && out.apiResponses[0]?.status === 200, "API response captured");
  assert(JSON.stringify(out.apiResponses[0].body) === JSON.stringify([{ id: 1, days: 2 }]), "real API body returned");
  assert(out.events.some((e) => e.type === "apiRequest" && e.transport === "http"), "event marks http transport");

  // A 404 (stale/gone) is classified for relearn, still no browser.
  fs.writeFileSync(planPath, JSON.stringify({
    action: "web.query-leaves",
    operations: [{ type: "apiRequest", url: `${base}api/missing`, method: "GET", risk: "read" }],
  }));
  const missing = JSON.parse((await runExecutor(playbookPath, planPath)).stdout);
  assert(missing.ok === false && missing.transport === "http", "404 handled over http");
  assert(missing.staleSignal === "api_404" && missing.relearnRecommended === true, "404 flagged stale → relearn, no browser");

  console.log("PASS: test-web-system-api-execution (8 tests)");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
