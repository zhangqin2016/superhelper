#!/usr/bin/env node
// Platform search (阿里 IQS) answers first when this install has it — most
// users are in mainland China — and the provider chosen in settings is the
// fallback. 2026-09-28 the setting was SearXNG with no URL, every public
// instance was unreachable from China, they were tried one after another
// (63 s), and IQS, configured on the same machine, was never asked. Local mock
// servers stand in for every endpoint.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "resources/skills/websearch/scripts/websearch.cjs");

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// The public default instances are routed to a local server that never
// answers, so the test stays on this machine and the race is observable.
const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "websearch-test-")), "offline.cjs");
fs.writeFileSync(preload, `
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return realFetch(url, init);
  return realFetch(process.env.TEST_UNREACHABLE_URL + u.pathname + u.search, init);
};
`);

function run(env, query = "乘联会 8月 销量") {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["-r", preload, script], {
      env: { PATH: process.env.PATH, WEBSEARCH_TIMEOUT_MS: "3000", TEST_UNREACHABLE_URL: slow.url, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify({ query }));
  });
}

let iqsFails = false;
const iqsCalls = [];
const iqs = await serve((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    iqsCalls.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("content-type", "application/json");
    if (iqsFails) { res.statusCode = 503; res.end(JSON.stringify({ message: "service busy" })); return; }
    res.end(JSON.stringify({ pageItems: [{ title: "8月乘用车市场", link: "https://example.cn/cpca-aug", snippet: "零售 200 万辆" }] }));
  });
});
const searxCalls = { broken: 0, good: 0 };
const broken = await serve((req, res) => { searxCalls.broken += 1; res.statusCode = 502; res.end("bad gateway"); });
const slow = await serve(() => { /* never answers — the request times out */ });
const good = await serve((req, res) => {
  searxCalls.good += 1;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ results: [{ title: "SearXNG hit", url: "https://example.org/hit", content: "from searxng" }] }));
});

const IQS_ENV = { WEBSEARCH_IQS_API_KEY: "test-key", WEBSEARCH_IQS_API_URL: iqs.url };
const reset = () => { iqsCalls.length = 0; searxCalls.broken = 0; searxCalls.good = 0; iqsFails = false; };

try {
  // 1. SearXNG chosen, IQS available → IQS answers first; SearXNG is never contacted.
  {
    reset();
    const r = await run({ WEBSEARCH_PROVIDER: "searxng", WEBSEARCH_SEARXNG_URL: good.url, ...IQS_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /example\.cn\/cpca-aug/, "the IQS result reaches the agent");
    assert.match(r.stderr, /\(iqs → searxng\)/, "the order is logged");
    assert.equal(iqsCalls.length, 1);
    assert.equal(iqsCalls[0].auth, "Bearer test-key");
    assert.equal(iqsCalls[0].body.query, "乘联会 8月 销量");
    assert.equal(searxCalls.good, 0, "platform search answered; the fallback was not asked");
  }

  // 2. IQS cannot answer → the chosen SearXNG answers, the cause is logged, and
  //    the race ends with the first answer while the other instances hang.
  {
    reset();
    iqsFails = true;
    const r = await run({ WEBSEARCH_PROVIDER: "searxng", WEBSEARCH_SEARXNG_URL: good.url, ...IQS_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /example\.org\/hit/);
    assert.match(r.stderr, /iqs failed \(阿里 IQS HTTP 503: service busy\); falling back/);
    assert.match(r.stderr, /answered by searxng after iqs failed/);
    assert.equal(searxCalls.good, 1);
    assert.ok(r.ms < 2500, `the first answer wins the race and the losers are aborted (took ${r.ms} ms)`);
  }

  // 3. Both fail → exit 1 with the last failure, and six hanging instances cost
  //    one timeout, not one each.
  {
    reset();
    iqsFails = true;
    const r = await run({ WEBSEARCH_PROVIDER: "searxng", WEBSEARCH_SEARXNG_URL: broken.url, ...IQS_ENV, WEBSEARCH_TIMEOUT_MS: "1500" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /iqs failed .*falling back/);
    assert.match(r.stderr, /\[error:websearch\] No search results from any SearXNG instance \(\d+ tried\)/);
    assert.ok(r.ms < 1500 * 3, `instances raced (took ${r.ms} ms)`);
  }

  // 4. No IQS key → the chosen provider alone, as before.
  {
    reset();
    const r = await run({ WEBSEARCH_PROVIDER: "searxng", WEBSEARCH_SEARXNG_URL: good.url });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /example\.org\/hit/);
    assert.equal(iqsCalls.length, 0);
  }

  // 5. Kill switch: WEBSEARCH_FALLBACK=0 keeps the chosen provider alone.
  {
    reset();
    const r = await run({ WEBSEARCH_PROVIDER: "searxng", WEBSEARCH_SEARXNG_URL: good.url, ...IQS_ENV, WEBSEARCH_FALLBACK: "0" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(iqsCalls.length, 0);
    assert.equal(searxCalls.good, 1);
  }

  // 6. IQS chosen: IQS alone; its failure is reported, nothing else is asked.
  {
    reset();
    iqsFails = true;
    const r = await run({ ...IQS_ENV });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\[error:websearch\] 阿里 IQS HTTP 503/);
    assert.equal(searxCalls.good + searxCalls.broken, 0);
  }
  console.log("test-websearch-provider-fallback: ok");
} finally {
  for (const s of [iqs, broken, slow, good]) { s.server.closeAllConnections?.(); s.server.close(); }
  fs.rmSync(path.dirname(preload), { recursive: true, force: true });
}
