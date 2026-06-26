#!/usr/bin/env node
/**
 * Closed-loop verification of CSRF/session cookie rotation in the executor's HTTP
 * path (web-system-learning optimization #3), against a LOCAL mock server.
 *
 * WHY it matters: CSRF tokens use the double-submit pattern — a cookie (e.g.
 * XSRF-TOKEN) the client echoes in a header (X-XSRF-Token). Servers ROTATE that
 * cookie. The stateless HTTP path would resend the captured-once token and trip
 * 403 on the second/write request. Acting as a cookie jar (merge Set-Cookie into
 * the in-memory session) keeps both session and CSRF tokens fresh. Purely
 * additive: no Set-Cookie => no change (today's behavior).
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

// Mock server: GET /rotate hands out a fresh CSRF cookie; POST /submit only
// accepts the CURRENT token in the X-XSRF-Token header.
function startServer() {
  const seen = { submitToken: null };
  const server = http.createServer((req, res) => {
    if (req.url === "/rotate") {
      res.setHeader("Set-Cookie", "XSRF-TOKEN=tok2; Path=/");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // POST /submit
    seen.submitToken = req.headers["x-xsrf-token"] || null;
    if (seen.submitToken === "tok2") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ done: true }));
    } else {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid csrf token" }));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

function runExecutor(tmp, base, operations) {
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
    actions: [{ action: "web.submit", title: "Submit", risk: "submit", confirmation: "explicit", metadata: { apiContractRefs: [] } }],
  });
  const plan = write("plan.json", { action: "web.submit", operations });
  // Stale captured CSRF cookie + a header rule echoing it (double-submit pattern).
  const storage = write("storage.json", { cookies: [{ name: "XSRF-TOKEN", value: "tok1", domain: "127.0.0.1", path: "/" }], origins: [] });
  const recipe = write("auth-recipe.json", {
    schemaVersion: 1,
    baseUrl: `${base}/`,
    allowedDomains: ["127.0.0.1"],
    headerRules: [{ name: "X-XSRF-Token", source: "cookie", key: "XSRF-TOKEN", format: "{{value}}" }],
    unresolvedHeaders: [],
    refreshCandidates: [],
  });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [executor, "--playbook", playbook, "--action", "web.submit", "--plan", plan, "--storage-state", storage, "--auth-recipe", recipe, "--confirmed"],
      { cwd: ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`no JSON. stderr=${stderr} stdout=${stdout}`));
      }
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-csrf-"));
const { server, port, seen } = await startServer();
const base = `http://127.0.0.1:${port}`;
try {
  // 1) rotate (server rotates the CSRF cookie) THEN submit: the executor must echo
  //    the FRESH token, not the captured-once stale one.
  {
    const result = await runExecutor(tmp, base, [
      { type: "apiRequest", method: "GET", url: `${base}/rotate`, risk: "read" },
      { type: "apiRequest", method: "POST", url: `${base}/submit`, risk: "submit" },
    ]);
    assert.equal(result.ok, true, "write succeeds after the CSRF cookie rotated");
    assert.equal(seen.submitToken, "tok2", "executor echoed the FRESH rotated token, not the stale captured one");
  }

  // 2) control: submit WITHOUT the rotate step still sends the stale token -> 403.
  //    Proves the server really enforces CSRF, so test 1's success is meaningful.
  {
    seen.submitToken = null;
    const result = await runExecutor(tmp, base, [
      { type: "apiRequest", method: "POST", url: `${base}/submit`, risk: "submit" },
    ]);
    assert.equal(result.ok, false, "stale CSRF token is rejected (server genuinely checks)");
    assert.equal(seen.submitToken, "tok1", "the stale captured token was the one sent");
  }

  console.log("web-system-csrf-rotation: ok");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
