#!/usr/bin/env node
// Guards the fix for "fetch failed" mid-film: requestJson (shared by every video
// provider) must retry transient socket failures. WHY: a finished film fires dozens
// of sequential requests; undici reuses keep-alive sockets the server has dropped
// and throws "fetch failed". Without retry, one transient blip aborts the whole
// film — exactly what happened. curl/short tests pass because they open one fresh
// connection; the film does not.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const shared = require("../resources/skills/lily-video-generation/scripts/providers/_shared.cjs");

const okResp = (body) => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) });
const errResp = (status) => ({ ok: false, status, statusText: "x", text: async () => JSON.stringify({ message: "boom" }) });
const originalFetch = globalThis.fetch;

try {
  // classification
  assert.equal(shared.isRetryableError(new TypeError("fetch failed")), true);
  assert.equal(shared.isRetryableError(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
  assert.equal(shared.isRetryableError(Object.assign(new Error("x"), { __retryStatus: true })), true);
  assert.equal(shared.isRetryableError(new Error("invalid model id")), false, "plain API errors are NOT retried");

  // transient "fetch failed" twice, then success → requestJson recovers
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return okResp({ output: { task_id: "t1" } });
  };
  const data = await shared.requestJson("https://x/y", { retries: 3, timeoutMs: 1000 });
  assert.equal(calls, 3, "retried the two transient failures then succeeded");
  assert.equal(data.output.task_id, "t1");

  // COST GUARD: a POST (billable create) must NOT auto-retry, even on a transient
  // "fetch failed" — retrying a create that may have already run double-charges.
  calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError("fetch failed"); };
  await assert.rejects(() => shared.requestJson("https://x/create", { method: "POST", timeoutMs: 1000 }));
  assert.equal(calls, 1, "POST create is not auto-retried (no double-charge)");

  // a GET poll, by contrast, retries the same transient failure
  calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError("fetch failed"); };
  await assert.rejects(() => shared.requestJson("https://x/poll", { method: "GET", retries: 2, timeoutMs: 1000 }));
  assert.equal(calls, 3, "GET poll retries the transient failure");

  // 4xx fails fast (no retry) — real client error
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return errResp(400); };
  await assert.rejects(() => shared.requestJson("https://x/y", { retries: 3, timeoutMs: 1000 }), /boom/);
  assert.equal(calls, 1, "4xx is not retried");

  // 5xx is retried then surfaces if it never recovers
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return errResp(503); };
  await assert.rejects(() => shared.requestJson("https://x/y", { retries: 2, timeoutMs: 1000 }));
  assert.equal(calls, 3, "5xx retried up to the limit (1 + 2)");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("media-request-retry: ok");
