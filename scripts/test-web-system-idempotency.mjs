#!/usr/bin/env node
/**
 * Closed-loop verification of idempotent safe-retry in the executor's HTTP path
 * (web-system-learning optimization #5), against a LOCAL mock server.
 *
 * WHY it matters: a write that fails on a NETWORK error (dropped connection) can't
 * be retried safely without a stable idempotency key — a blind retry risks a
 * duplicate submission. Opt-in op.idempotent injects a stable Idempotency-Key and
 * allows exactly one network-error retry reusing the SAME key, so the server
 * dedupes. Fail-safe: without the flag, no key and no retry (today's behavior).
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

// Mock server: the first POST /create drops the socket (network failure); a retry
// succeeds. Records the Idempotency-Key seen on every attempt.
function startServer() {
  const state = { attempts: 0, keys: [] };
  const server = http.createServer((req, res) => {
    state.attempts += 1;
    state.keys.push(req.headers["idempotency-key"] || null);
    if (state.attempts === 1) {
      req.socket.destroy(); // simulate a dropped connection -> client fetch throws
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 1 }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state })));
}

function runExecutor(tmp, base, op) {
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
    actions: [{ action: "web.create", title: "Create", risk: "submit", confirmation: "explicit", metadata: { apiContractRefs: [] } }],
  });
  const plan = write("plan.json", { action: "web.create", operations: [op] });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [executor, "--playbook", playbook, "--action", "web.create", "--plan", plan, "--confirmed"],
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-idem-"));
try {
  // 1) idempotent write: dropped connection -> ONE retry with the SAME key -> success.
  {
    const { server, port, state } = await startServer();
    const base = `http://127.0.0.1:${port}`;
    try {
      const result = await runExecutor(tmp, base, { type: "apiRequest", method: "POST", url: `${base}/create`, risk: "submit", idempotent: true });
      assert.equal(result.ok, true, "network failure recovered via safe retry");
      assert.equal(state.attempts, 2, "exactly one retry (2 attempts)");
      assert.ok(state.keys[0], "an Idempotency-Key was sent");
      assert.equal(state.keys[0], state.keys[1], "the SAME key on both attempts so the server can dedupe");
    } finally {
      server.close();
    }
  }

  // 2) control (not idempotent): no key, no retry -> fails on the first drop (today's behavior).
  {
    const { server, port, state } = await startServer();
    const base = `http://127.0.0.1:${port}`;
    try {
      const result = await runExecutor(tmp, base, { type: "apiRequest", method: "POST", url: `${base}/create`, risk: "submit" });
      assert.equal(result.ok, false, "without opt-in, a dropped write is not retried");
      assert.equal(state.attempts, 1, "no retry attempted");
      assert.equal(state.keys[0], null, "no Idempotency-Key injected when not opted in");
    } finally {
      server.close();
    }
  }

  console.log("web-system-idempotency: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
