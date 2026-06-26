#!/usr/bin/env node
/**
 * Closed-loop verification of opt-in pagination in the web-playbook executor
 * (web-system-learning optimization #2), against a LOCAL mock server.
 *
 * WHY it matters: a learned list endpoint returns one page; without this the agent
 * silently gets partial results (looks complete, isn't). With op.pagination the
 * executor fetches and aggregates subsequent pages. It must be OPT-IN (no spec =
 * single request = today), CAPPED (never runaway), and FAIL-SAFE (malformed spec =
 * single page, never a broken action).
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

// Mock server: /page (page/size), /cursor (cursor chain), /forever (never ends).
function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/page") {
      const page = Number(u.searchParams.get("page") || "1");
      const data = { 1: [1, 2, 3], 2: [4, 5, 6], 3: [7] }[page] || [];
      return json({ rows: data, page });
    }
    if (u.pathname === "/cursor") {
      const c = u.searchParams.get("cursor") || "";
      if (c === "c2") return json({ rows: [3, 4], nextCursor: "c3" });
      if (c === "c3") return json({ rows: [5], nextCursor: null });
      return json({ rows: [1, 2], nextCursor: "c2" });
    }
    // /forever: always another page (to exercise the maxPages cap)
    return json({ rows: [0], nextCursor: "more" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function runExecutor(tmp, base, pathAndQuery, pagination) {
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
    actions: [{ action: "web.list", title: "List", risk: "submit", confirmation: "explicit", metadata: { apiContractRefs: [] } }],
  });
  const op = { type: "apiRequest", method: "GET", url: `${base}${pathAndQuery}`, risk: "read" };
  if (pagination) op.pagination = pagination;
  const plan = write("plan.json", { action: "web.list", operations: [op] });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [executor, "--playbook", playbook, "--action", "web.list", "--plan", plan, "--confirmed"],
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

const agg = (result) => (result.extracted || []).find((e) => e.paginated);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-pagination-"));
const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
try {
  // 1) page/size mode: 3 + 3 + 1 = 7 items across 3 pages, stop on the short last page.
  {
    const result = await runExecutor(tmp, base, "/page", { mode: "page", param: "page", itemsPath: "rows", start: 1, size: 3, maxPages: 10 });
    assert.equal(result.ok, true, "paginated read succeeds");
    const a = agg(result);
    assert.ok(a, "an aggregated (all pages) entry is produced");
    assert.equal(a.total, 7, "all 7 items aggregated across pages");
    assert.equal(a.pages, 3, "fetched exactly 3 pages");
    assert.equal(a.stopped, "last-page", "stopped because the last page was short");
  }

  // 2) cursor mode: follow nextCursor until it's null.
  {
    const result = await runExecutor(tmp, base, "/cursor", { mode: "cursor", param: "cursor", itemsPath: "rows", nextPath: "nextCursor", maxPages: 10 });
    const a = agg(result);
    assert.equal(a.total, 5, "cursor chain aggregated all 5 items");
    assert.equal(a.pages, 3, "followed the cursor for 3 pages");
    assert.equal(a.stopped, "no-cursor", "stopped when nextCursor went null");
  }

  // 3) maxPages cap: a never-ending feed stops at the cap and SAYS SO (no silent truncation).
  {
    const result = await runExecutor(tmp, base, "/forever", { mode: "cursor", param: "cursor", itemsPath: "rows", nextPath: "nextCursor", maxPages: 3 });
    const a = agg(result);
    assert.equal(a.pages, 3, "capped at maxPages");
    assert.equal(a.stopped, "max-pages", "the cap is surfaced, not hidden");
  }

  // 4) fail-safe: malformed spec -> single page, no aggregation, action still ok (today's behavior).
  {
    const result = await runExecutor(tmp, base, "/page", { mode: "bogus", itemsPath: "rows" });
    assert.equal(result.ok, true, "malformed pagination does not break the action");
    assert.equal(agg(result), undefined, "no aggregation attempted; degrades to a single page");
  }

  console.log("web-system-pagination: ok");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
