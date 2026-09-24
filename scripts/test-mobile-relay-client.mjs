#!/usr/bin/env node
// The phone's connection state machine (web/lib/mobile/relay-client.mjs),
// against a fake WebSocket, storage, fetch and clock.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createRelayClient, parsePairingCode, parseScanHash, GRANT_STORAGE_KEY, MESSAGES } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/relay-client.mjs")).href);

class FakeWS {
  static OPEN = 1;
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(f) { this.onmessage?.({ data: JSON.stringify(f) }); }
  async drop(code = 1006) { this.readyState = 3; await this.onclose?.({ code }); }
  close() { this.readyState = 3; }
}

function harness({ saved = null, fetchReplies = {} } = {}) {
  FakeWS.all = [];
  const store = new Map(saved ? [[GRANT_STORAGE_KEY, JSON.stringify(saved)]] : []);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const timers = [];
  const posts = [];
  const statuses = [];
  const frames = [];
  let clock = 1_000_000;
  const client = createRelayClient({
    deviceId: "mweb_phone",
    pageOrigin: "https://lily.example",
    storage,
    fetchImpl: async (url, opts) => {
      const pathName = new URL(url).pathname;
      posts.push({ path: pathName, body: JSON.parse(opts.body) });
      const reply = fetchReplies[pathName] || { status: 200, json: { ok: true } };
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.json };
    },
    WebSocketImpl: FakeWS,
    setTimeoutImpl: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeoutImpl: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    now: () => clock,
    onFrame: (f) => frames.push(f),
    onStatus: (s) => statuses.push(s),
  });
  return { client, store, timers, posts, statuses, frames, advance: (ms) => { clock += ms; } };
}

// --- parsing ---------------------------------------------------------------------
assert.deepEqual(parsePairingCode("https://api.example/#tok", "https://page"), { url: "https://api.example", token: "tok" });
assert.deepEqual(parsePairingCode("tok", "https://page"), { url: "https://page", token: "tok" });
assert.deepEqual(parseScanHash("#u=https%3A%2F%2Fapi.example&t=tok", "https://page"), { url: "https://api.example", token: "tok" });
assert.deepEqual(parseScanHash("#t=tok", "https://page"), { url: "https://page", token: "tok" });
assert.equal(parseScanHash("#other", "https://page"), null);

// --- scan → waiting for approval → online; the token is consumed once ---------
{
  const h = harness({ fetchReplies: { "/api/mobile/pairing/consume": { status: 200, json: { ok: true, grantId: "g1", mobileToken: "mt1" } } } });
  assert.equal(await h.client.pair("https://lily.example#once"), true);
  assert.equal(await h.client.pair("https://lily.example#once"), false, "a one-time code is never consumed twice");
  assert.equal(h.posts.filter((p) => p.path === "/api/mobile/pairing/consume").length, 1);
  assert.equal(h.client.phase(), "waiting");
  const url = new URL(FakeWS.all[0].url);
  assert.deepEqual([url.searchParams.get("role"), url.searchParams.get("grantId"), url.searchParams.get("token")], ["mobile", "g1", "mt1"]);
  // Not approved yet: the relay refuses; the phone keeps waiting.
  await FakeWS.all[0].drop();
  assert.equal(h.client.phase(), "waiting");
  assert.equal(h.timers[0].ms, 2000);
  h.timers.shift().fn();
  FakeWS.all[1].open();
  assert.equal(h.client.phase(), "online");
  assert.ok(h.store.has(GRANT_STORAGE_KEY), "the pairing is remembered");
  FakeWS.all[1].receive({ type: "relay.presence", desktopOnline: true });
  assert.deepEqual(h.frames, [{ type: "relay.presence", desktopOnline: true }]);
  assert.equal(h.client.send({ type: "session.request" }), true);
  assert.deepEqual(FakeWS.all[1].sent, [{ type: "session.request" }]);

  // Revoked on the desktop: ended, forgotten, no retry.
  await FakeWS.all[1].drop(4001);
  assert.equal(h.client.phase(), "ended");
  assert.equal(h.statuses.at(-1).message, MESSAGES.revoked);
  assert.ok(!h.store.has(GRANT_STORAGE_KEY));
  assert.equal(h.timers.length, 0, "no reconnect storm");
}

// --- never approved: gives up with a clear message ------------------------------
{
  const h = harness({ fetchReplies: { "/api/mobile/pairing/consume": { status: 200, json: { ok: true, grantId: "g1", mobileToken: "mt1" } } } });
  await h.client.pair("https://lily.example#once");
  for (let i = 0; i < 60 && h.client.phase() === "waiting"; i += 1) {
    await FakeWS.all.at(-1).drop();
    h.timers.shift()?.fn();
  }
  assert.equal(h.client.phase(), "ended");
  assert.equal(h.statuses.at(-1).message, MESSAGES.approvalTimeout);
}

// --- an expired code says so -----------------------------------------------------
{
  const h = harness({ fetchReplies: { "/api/mobile/pairing/consume": { status: 409, json: { ok: false, code: "PAIRING_CHALLENGE_INVALID_OR_EXPIRED" } } } });
  assert.equal(await h.client.pair("https://lily.example#old"), false);
  assert.equal(h.client.phase(), "error");
  assert.equal(h.statuses.at(-1).message, MESSAGES.codeExpired);
  assert.equal(FakeWS.all.length, 0);
}

// --- reopening: the saved pairing reconnects; an old token is renewed ----------
{
  const saved = { url: "https://lily.example", grantId: "g1", mobileToken: "old", savedAt: 0 };
  const h = harness({ saved, fetchReplies: { "/api/mobile/grant/refresh": { status: 200, json: { ok: true, mobileToken: "renewed" } } } });
  assert.equal(h.client.resume(), true);
  assert.equal(h.client.phase(), "connecting");
  h.advance(7 * 60 * 60 * 1000);
  FakeWS.all[0].open();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.posts.map((p) => p.path), ["/api/mobile/grant/refresh"], "a token older than 6 h is renewed on connect");
  assert.equal(JSON.parse(h.store.get(GRANT_STORAGE_KEY)).mobileToken, "renewed");

  // A drop reconnects with backoff, using the renewed token; a visible tab skips the wait.
  await FakeWS.all[0].drop();
  assert.equal(h.client.phase(), "reconnecting");
  assert.equal(h.statuses.at(-1).message, MESSAGES.reconnecting);
  h.client.reconnectNow();
  assert.match(FakeWS.all[1].url, /token=renewed/);
  FakeWS.all[1].open();
  assert.equal(h.client.phase(), "online");
}

// --- a pairing that died while away: detected by the renewal, ended -----------
{
  const saved = { url: "https://lily.example", grantId: "g1", mobileToken: "t", savedAt: 1_000_000 };
  const h = harness({ saved, fetchReplies: { "/api/mobile/grant/refresh": { status: 409, json: { ok: false, code: "GRANT_INACTIVE" } } } });
  h.client.resume();
  for (let i = 0; i < 5 && h.client.phase() !== "ended"; i += 1) {
    await FakeWS.all.at(-1).drop();
    h.timers.shift()?.fn();
  }
  assert.equal(h.client.phase(), "ended");
  assert.equal(h.statuses.at(-1).message, MESSAGES.lapsed);
  assert.ok(!h.store.has(GRANT_STORAGE_KEY));
}

// --- direct code: active at once ---------------------------------------------------
{
  const h = harness({ fetchReplies: { "/api/mobile/direct/consume": { status: 200, json: { ok: true, grantId: "gd", mobileToken: "md" } } } });
  assert.equal(await h.client.directConnect(" k7q2mx ", " 4815 "), true);
  assert.deepEqual(h.posts[0].body, { deviceId: "mweb_phone", code: "k7q2mx", password: "4815" });
  assert.equal(h.client.phase(), "connecting");
  await FakeWS.all[0].drop();
  assert.equal(h.client.phase(), "reconnecting", "an active pairing reconnects; it never 'awaits approval'");
  const locked = harness({ fetchReplies: { "/api/mobile/direct/consume": { status: 409, json: { ok: false, code: "DIRECT_CODE_LOCKED" } } } });
  await locked.client.directConnect("x", "y");
  assert.equal(locked.statuses.at(-1).message, MESSAGES.directLocked);
}

// --- authorized posts carry the pairing ------------------------------------------
{
  const saved = { url: "https://lily.example", grantId: "g1", mobileToken: "t", savedAt: 1_000_000 };
  const h = harness({ saved });
  h.client.resume();
  await h.client.authorizedPost("/api/mobile/asr/token");
  assert.deepEqual(h.posts.at(-1), { path: "/api/mobile/asr/token", body: { deviceId: "mweb_phone", grantId: "g1", token: "t" } });
}

console.log("mobile-relay-client: ok");
