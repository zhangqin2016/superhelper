// The desktop notices a web purchase by itself: after the billing page opens it
// asks quietly on focus / a slow timer, and announces only a real rise — never
// usage going down, never a stale cache, never after the watch is stopped.
import assert from "node:assert/strict";
import { createPurchaseWatch, purchaseArrived } from "../src/renderer/modules/purchase-watch.js";

const base = { tokenBalance: 1000, imageGenerationsRemaining: 2, videoGenerationsRemaining: 0, membershipExpiresAt: "2026-10-01T00:00:00.000Z" };
assert.equal(purchaseArrived(base, { ...base }), false);
assert.equal(purchaseArrived(base, { ...base, tokenBalance: 400 }), false, "usage is not a purchase");
assert.equal(purchaseArrived(base, { ...base, tokenBalance: 101000 }), true);
assert.equal(purchaseArrived(base, { ...base, videoGenerationsRemaining: 5 }), true);
assert.equal(purchaseArrived(base, { ...base, membershipExpiresAt: "2026-11-01T00:00:00.000Z" }), true, "a longer membership is a purchase");
assert.equal(purchaseArrived(null, { tokenBalance: 5 }), true);
assert.equal(purchaseArrived(base, null), false);

function harness(replies) {
  let clock = 0;
  const listeners = new Map();
  const timers = new Set();
  const target = { addEventListener: (k, fn) => listeners.set(`w:${k}`, fn), removeEventListener: (k) => listeners.delete(`w:${k}`) };
  const doc = { visibilityState: "visible", addEventListener: (k, fn) => listeners.set(`d:${k}`, fn), removeEventListener: (k) => listeners.delete(`d:${k}`) };
  const arrived = [];
  let asks = 0;
  const watch = createPurchaseWatch({
    fetchEntitlements: async () => { asks += 1; const r = replies.shift(); if (r instanceof Error) throw r; return r; },
    onArrived: (e) => arrived.push(e),
    target, doc,
    now: () => clock,
    setTimer: (fn) => { const id = { fn }; timers.add(id); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    watch, arrived, listeners, timers, doc,
    get asks() { return asks; },
    advance(ms) { clock += ms; },
    async focus() { listeners.get("w:focus")?.(); await settle(); await settle(); },
    settle,
  };
}

// 1. A stale cache never passes for a purchase: the fresh read at start is the bar.
{
  const h = harness([{ ok: true, entitlements: { ...base, tokenBalance: 5000 } }, { ok: true, entitlements: { ...base, tokenBalance: 5000 } }]);
  h.watch.start({ ...base, tokenBalance: 1000 });
  await h.settle(); await h.settle();
  h.advance(11_000);
  await h.focus();
  assert.equal(h.arrived.length, 0, "the stale cache (1000) is not compared against");
  assert.equal(h.watch.watching, true);
}

// 2. Usage while paying, then the purchase: announced once, then the watch ends.
{
  const h = harness([
    { ok: true, entitlements: base },
    { ok: true, entitlements: { ...base, tokenBalance: 600 } },
    new Error("offline"),
    { ok: false, code: "NETWORK" },
    { ok: true, entitlements: { ...base, tokenBalance: 100600 } },
  ]);
  h.watch.start(base);
  await h.settle(); await h.settle();
  await h.focus();
  assert.equal(h.asks, 1, "no ask within the first seconds (the buyer is still on the way)");
  for (let i = 0; i < 3; i += 1) { h.advance(11_000); await h.focus(); }
  assert.equal(h.arrived.length, 0, "usage and failed asks are silent");
  h.advance(11_000);
  await h.focus();
  assert.equal(h.arrived.length, 1);
  assert.equal(h.arrived[0].tokenBalance, 100600);
  assert.equal(h.watch.watching, false);
  assert.equal(h.timers.size, 0, "timer cleared");
  assert.equal(h.listeners.size, 0, "listeners removed");
}

// 3. Hidden window: no asks. Expired watch: stops by itself.
{
  const h = harness([{ ok: true, entitlements: base }]);
  h.watch.start(base);
  await h.settle(); await h.settle();
  h.doc.visibilityState = "hidden";
  h.advance(11_000);
  await h.focus();
  assert.equal(h.asks, 1, "a hidden window does not ask");
  h.doc.visibilityState = "visible";
  h.advance(31 * 60_000);
  await h.focus();
  assert.equal(h.watch.watching, false, "the watch ends after 30 minutes");
  assert.equal(h.asks, 1);
}

// 4. Stopped (logout / other account): a late answer never announces.
{
  let release;
  const h = harness([]);
  const gate = new Promise((r) => { release = r; });
  const watch = createPurchaseWatch({
    fetchEntitlements: () => gate,
    onArrived: () => assert.fail("must not announce after stop"),
    target: { addEventListener() {}, removeEventListener() {} },
    doc: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    setTimer: () => 1, clearTimer: () => {},
  });
  watch.start(base);
  watch.stop();
  release({ ok: true, entitlements: { ...base, tokenBalance: 999999 } });
  await h.settle();
}

// The hook: opened billing starts the watch; logout and account switch stop it.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/renderer/modules/account-settings.js", import.meta.url), "utf8");
assert.match(src, /window\.open\(result\.url[^\n]*\n\s*watchedAccount = currentAccountPhone;\n\s*purchaseWatch\.start\(shownEntitlements\);/);
assert.match(src, /if \(!status\?\.loggedIn\) \{\n\s*purchaseWatch\.stop\(\);/);
assert.match(src, /if \(watchedAccount !== currentAccountPhone\) purchaseWatch\.stop\(\);/);
for (const locale of ["zh-CN", "en", "ar"]) {
  const json = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
  assert.ok(json["settings.accountPurchaseArrived"], `${locale} has the arrival toast`);
}

console.log("purchase-watch: ok");
