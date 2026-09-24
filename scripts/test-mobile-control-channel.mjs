#!/usr/bin/env node
// The desktop's one relay connection: a fresh token per connect, typed events
// from control frames, envelopes on send, and recovery that neither dies nor
// fights (a replaced channel backs off; a signed-out desktop opens nothing).
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createControlChannel } = require(path.join(ROOT, "src/main/mobile/control-channel.js"));

class FakeWS {
  static OPEN = 1;
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.all.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close(code) { this.readyState = 3; this.onclose?.({ code }); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- connect, dispatch, send ----------------------------------------------------
{
  FakeWS.all = [];
  const events = [];
  let tokens = 0;
  const timers = [];
  const channel = createControlChannel({
    getUrl: () => "wss://lily.example/api/mobile/relay",
    getToken: async () => { tokens += 1; return `tok${tokens}`; },
    getDeviceId: () => "dtop",
    onEvent: (e) => events.push(e),
    WebSocketCtor: FakeWS,
    setTimeoutImpl: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeoutImpl: () => {},
  });
  channel.start();
  await tick();
  const ws = FakeWS.all[0];
  const url = new URL(ws.url);
  assert.equal(url.searchParams.get("role"), "desktop");
  assert.equal(url.searchParams.get("grantId"), null, "a control channel names no pairing");
  assert.equal(url.searchParams.get("deviceId"), "dtop");
  assert.equal(url.searchParams.get("token"), "tok1");
  assert.equal(channel.send("g1", { type: "x" }), false, "nothing is sent before the socket is open");
  ws.open();
  assert.equal(channel.status(), "online");

  ws.receive({ type: "control.hello", protocol: 2, grants: [{ grantId: "g1" }], pending: [{ grantId: "p1" }] });
  ws.receive({ type: "control.pairing.pending", grant: { grantId: "p2" } });
  ws.receive({ type: "control.grant.active", grant: { grantId: "p2" } });
  ws.receive({ type: "control.grant.ended", grantId: "g1", reason: "user_action" });
  ws.receive({ type: "control.presence", grantId: "p2", mobilesOnline: 1 });
  ws.receive({ type: "relay.frame", grantId: "p2", frame: { type: "command", commandId: "c1" } });
  ws.receive({ type: "relay.frame", grantId: "p2", frame: "not a frame" });
  ws.receive({ type: "something.else" });
  assert.deepEqual(events.filter((e) => e.type !== "status"), [
    { type: "hello", grants: [{ grantId: "g1" }], pending: [{ grantId: "p1" }] },
    { type: "pending", grant: { grantId: "p2" } },
    { type: "active", grant: { grantId: "p2" } },
    { type: "ended", grantId: "g1", reason: "user_action" },
    { type: "presence", grantId: "p2", mobilesOnline: 1 },
    { type: "phone-frame", grantId: "p2", frame: { type: "command", commandId: "c1" } },
  ], "control frames become typed events; junk is dropped");

  assert.equal(channel.send("p2", { type: "assistant.delta", text: "hi" }), true);
  assert.deepEqual(ws.sent.at(-1), { type: "relay.frame", grantId: "p2", frame: { type: "assistant.delta", text: "hi" } }, "phone frames go out in an envelope naming the pairing");

  // A dropped connection reconnects with a token fetched NOW (they last 15 min).
  ws.close(1006);
  assert.equal(channel.status(), "offline");
  assert.equal(timers.length, 1);
  timers.shift().fn();
  await tick();
  assert.equal(new URL(FakeWS.all[1].url).searchParams.get("token"), "tok2", "each connection gets a fresh token");
  FakeWS.all[1].open();

  // Replaced by another instance of this device: back off instead of fighting.
  FakeWS.all[1].close(4000);
  assert.ok(timers[0].ms >= 16_000, `a replaced channel retries slowly (got ${timers[0].ms}ms)`);

  channel.stop();
  assert.equal(channel.status(), "idle");
}

// --- signed out: no socket, retried later; kick() retries now ---------------------
{
  FakeWS.all = [];
  let signedIn = false;
  const statuses = [];
  const timers = [];
  const channel = createControlChannel({
    getUrl: () => "wss://lily.example/api/mobile/relay",
    getToken: async () => (signedIn ? "tok" : ""),
    getDeviceId: () => "dtop",
    onEvent: (e) => { if (e.type === "status") statuses.push(e.status); },
    WebSocketCtor: FakeWS,
    setTimeoutImpl: (fn) => { const t = { fn }; timers.push(t); return t; },
    clearTimeoutImpl: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  channel.start();
  await tick();
  assert.equal(FakeWS.all.length, 0, "no socket without an account");
  assert.deepEqual(statuses, ["signed-out"]);
  signedIn = true;
  channel.kick();
  await tick();
  assert.equal(FakeWS.all.length, 1, "kick() connects at once after sign-in");
  channel.stop();
}

// --- an event handler that throws never breaks the channel ------------------------
{
  FakeWS.all = [];
  const channel = createControlChannel({
    getUrl: () => "wss://x/api/mobile/relay",
    getToken: async () => "tok",
    getDeviceId: () => "d",
    onEvent: () => { throw new Error("boom"); },
    WebSocketCtor: FakeWS,
  });
  channel.start();
  await tick();
  FakeWS.all[0].open();
  FakeWS.all[0].receive({ type: "control.hello", grants: [], pending: [] });
  assert.equal(channel.status(), "online");
  channel.stop();
}

console.log("mobile-control-channel: ok");
