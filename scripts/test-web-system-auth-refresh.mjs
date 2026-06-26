#!/usr/bin/env node
/**
 * Closed-loop verification of session auto-refresh in the web-playbook executor
 * (web-system-learning optimization #1), against a LOCAL mock server — no browser,
 * no credentials, no external system.
 *
 * WHY it matters: a learned OA/ERP automation's session expires far more often
 * than its contracts go stale. Before this, a 401 forced a full re-learn (the user
 * had to log in again). Now, if learning captured a refresh endpoint, the executor
 * refreshes the session once and retries — so the automation survives token expiry.
 * Failure mode must degrade to today's behavior (mark stale), never worse.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const executor = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/execute_web_playbook.cjs");

// Mock OA server: /data needs a fresh session cookie; /refresh rotates it (or not).
function startServer({ refreshWorks }) {
  const counts = { data: 0, refresh: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/refresh") {
      counts.refresh += 1;
      if (refreshWorks) {
        res.setHeader("Set-Cookie", "session=fresh; Path=/");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "still unauthorized" }));
      }
      return;
    }
    counts.data += 1;
    if (/session=fresh/.test(req.headers.cookie || "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rows: [1, 2, 3] }));
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "session expired" }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, counts }));
  });
}

function runExecutor(tmp, port, { withRefreshCandidate }) {
  const base = `http://127.0.0.1:${port}`;
  const write = (name, obj) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  const playbook = write("playbook.json", {
    schemaVersion: 1,
    id: "mock",
    baseUrl: `${base}/`,
    allowedDomains: ["127.0.0.1"],
    apiContracts: [],
    actions: [{ action: "web.fetch", title: "Fetch data", risk: "submit", confirmation: "explicit", metadata: { apiContractRefs: [] } }],
  });
  const plan = write("plan.json", {
    action: "web.fetch",
    operations: [{ type: "apiRequest", method: "GET", url: `${base}/data`, risk: "read" }],
  });
  const storage = write("storage.json", { cookies: [{ name: "session", value: "stale", domain: "127.0.0.1", path: "/" }], origins: [] });
  const recipe = write("auth-recipe.json", {
    schemaVersion: 1,
    baseUrl: `${base}/`,
    allowedDomains: ["127.0.0.1"],
    headerRules: [],
    unresolvedHeaders: [],
    refreshCandidates: withRefreshCandidate ? [{ method: "POST", endpoint: `${base}/refresh`, source: "har" }] : [],
  });
  const audit = path.join(tmp, "audit.jsonl");
  // Use async spawn (NOT spawnSync): the mock server runs in THIS process, so the
  // event loop must stay free to answer the child executor's requests.
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [executor, "--playbook", playbook, "--action", "web.fetch", "--plan", plan, "--storage-state", storage, "--auth-recipe", recipe, "--audit-log", audit, "--confirmed"],
      { cwd: ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", () => {
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        reject(new Error(`executor produced no JSON. stderr=${stderr} stdout=${stdout}`));
        return;
      }
      const auditLines = fs.existsSync(audit)
        ? fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
      resolve({ result, auditLines });
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-auth-refresh-"));
try {
  // 1) Refresh available + works: 401 -> refresh -> retry -> success. Survives expiry.
  {
    const { server, port, counts } = await startServer({ refreshWorks: true });
    try {
      const { result, auditLines } = await runExecutor(tmp, port, { withRefreshCandidate: true });
      assert.equal(result.ok, true, "session refreshed and request retried successfully");
      assert.equal(counts.refresh, 1, "refresh endpoint called exactly once");
      assert.equal(counts.data, 2, "/data hit twice: initial 401 then post-refresh 200");
      assert.ok(auditLines.some((e) => e.phase === "auth-refresh" && e.ok === true), "auth-refresh recorded in the audit trail");
    } finally {
      server.close();
    }
  }

  // 2) Refresh available but FAILS: must degrade to today's behavior (stale), not worse.
  {
    const { server, port, counts } = await startServer({ refreshWorks: false });
    try {
      const { result } = await runExecutor(tmp, port, { withRefreshCandidate: true });
      assert.equal(result.ok, false, "failed refresh does not fake success");
      assert.equal(result.stale, true, "falls through to stale handling (relearn/fallback) — today's behavior");
      assert.equal(counts.refresh, 1, "refresh attempted exactly once (no retry storm)");
    } finally {
      server.close();
    }
  }

  // 3) No refresh candidate learned: behaves exactly as before (stale, no refresh call).
  {
    const { server, port, counts } = await startServer({ refreshWorks: true });
    try {
      const { result } = await runExecutor(tmp, port, { withRefreshCandidate: false });
      assert.equal(result.ok, false, "no candidate -> no refresh, fails as before");
      assert.equal(result.stale, true, "marked stale (unchanged behavior)");
      assert.equal(counts.refresh, 0, "refresh endpoint never called without a learned candidate");
    } finally {
      server.close();
    }
  }

  console.log("web-system-auth-refresh: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
