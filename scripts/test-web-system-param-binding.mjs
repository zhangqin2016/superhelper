#!/usr/bin/env node
/**
 * Closed-loop verification of parameter binding in the executor (web-system-learning
 * optimization #4), against a LOCAL mock server.
 *
 * WHY it matters: this is what turns one-off captures into REUSABLE automations.
 * Operations reference {{name}} resolved from (a) plan params and (b) values
 * EXTRACTED from earlier API responses (op.bind), enabling multi-step chains like
 * create -> read its id -> delete /item/{{id}}. A resolved URL is re-checked against
 * the allowlist so a binding can never redirect a request off-site.
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

function startServer() {
  const seen = { deletedPath: null, searchQ: null };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "POST" && u.pathname === "/create") return json({ id: "abc123" });
    if (req.method === "DELETE" && u.pathname.startsWith("/item/")) {
      seen.deletedPath = u.pathname;
      return json({ deleted: true });
    }
    if (u.pathname === "/search") {
      seen.searchQ = u.searchParams.get("q");
      return json({ ok: true });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

function runExecutor(tmp, base, operations, params) {
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
    actions: [{ action: "web.chain", title: "Chain", risk: "submit", confirmation: "explicit", metadata: { apiContractRefs: [] } }],
  });
  const plan = write("plan.json", { action: "web.chain", operations, ...(params ? { params } : {}) });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [executor, "--playbook", playbook, "--action", "web.chain", "--plan", plan, "--confirmed"],
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-bind-"));
const { server, port, seen } = await startServer();
const base = `http://127.0.0.1:${port}`;
try {
  // 1) extract-and-chain: POST returns an id, a later DELETE uses {{newId}} in its URL.
  {
    const result = await runExecutor(tmp, base, [
      { type: "apiRequest", method: "POST", url: `${base}/create`, risk: "submit", bind: { newId: "id" } },
      { type: "apiRequest", method: "DELETE", url: `${base}/item/{{newId}}`, risk: "submit" },
    ]);
    assert.equal(result.ok, true, "chained create -> delete succeeds");
    assert.equal(seen.deletedPath, "/item/abc123", "the id extracted from the create response bound into the delete URL");
  }

  // 2) plan params: {{q}} in a URL resolves from plan.params.
  {
    const result = await runExecutor(
      tmp,
      base,
      [{ type: "apiRequest", method: "GET", url: `${base}/search?q={{q}}`, risk: "read" }],
      { q: "hello" },
    );
    assert.equal(result.ok, true, "param-bound read succeeds");
    assert.equal(seen.searchQ, "hello", "plan param bound into the query string");
  }

  // 3) unknown placeholder is left intact (fail-safe — no crash, no silent blanking).
  {
    seen.deletedPath = null;
    const result = await runExecutor(tmp, base, [
      { type: "apiRequest", method: "DELETE", url: `${base}/item/{{missing}}`, risk: "submit" },
    ]);
    // /item/{{missing}} stays literal -> server still matches /item/* and records it
    assert.equal(seen.deletedPath, "/item/%7B%7Bmissing%7D%7D", "unknown {{name}} left intact (not blanked), request still well-formed");
    assert.equal(result.ok, true, "unresolved binding does not break the run");
  }

  console.log("web-system-param-binding: ok");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
