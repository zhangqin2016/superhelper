#!/usr/bin/env node
/**
 * Typing is a HINT channel: relayed, never persisted, and a missed frame must
 * degrade to "nobody is typing" rather than to a stuck indicator.
 *
 * The realtime gateway already validated and fanned these frames out; the gap
 * was that the client neither sent nor consumed them.
 */
import assert from "node:assert/strict";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const {
  MAX_CONVERSATIONS,
  MAX_TTL_MS,
  MAX_USERS_PER_CONVERSATION,
  createEphemeralPresence,
} = require("../src/main/collaboration/ephemeral-presence.js");
const { createCollaborationRealtimeClient } = require("../src/main/collaboration/realtime-client.js");

// --- self-expiring, no timers ------------------------------------------------
{
  let now = 1_000;
  const presence = createEphemeralPresence({ now: () => now });
  assert.equal(presence.note({ type: "typing", conversationId: "c", userId: "bob", ttlMs: 5_000 }), true, "a new typist is a change");
  assert.equal(presence.note({ type: "typing", conversationId: "c", userId: "bob", ttlMs: 5_000 }), false, "a re-send of the same typist is not");
  assert.deepEqual(presence.typingUserIds("c"), ["bob"]);
  assert.deepEqual(presence.snapshot(), { c: ["bob"] });
  now = 6_001;
  assert.deepEqual(presence.typingUserIds("c"), [], "the entry expires on its own, with no timer");
  assert.deepEqual(presence.snapshot(), {}, "an empty conversation leaves the snapshot entirely");
}

// --- the server's stamp wins, but never beyond the cap ----------------------
{
  let now = 1_000;
  const presence = createEphemeralPresence({ now: () => now });
  presence.note({ type: "typing", conversationId: "c", userId: "bob", ttlMs: 5_000, expiresAt: new Date(now + 10 * 60_000).toISOString() });
  now += MAX_TTL_MS + 1;
  assert.deepEqual(presence.typingUserIds("c"), [], "a hostile far-future stamp cannot pin an indicator open");
  // An unusable stamp falls back to the frame's own bounded ttl.
  presence.note({ type: "typing", conversationId: "c", userId: "bob", ttlMs: 4_000, expiresAt: "not-a-date" });
  assert.deepEqual(presence.typingUserIds("c"), ["bob"]);
}

// --- what must never be recorded -------------------------------------------
{
  const presence = createEphemeralPresence();
  for (const frame of [
    { type: "presence", conversationId: "c", userId: "bob", ttlMs: 5_000 }, // not typing
    { type: "typing", conversationId: "", userId: "bob", ttlMs: 5_000 },
    { type: "typing", conversationId: "c", userId: "", ttlMs: 5_000 },
    { type: "typing" }, {}, null, undefined,
  ]) {
    assert.equal(presence.note(frame), false, `must not record: ${JSON.stringify(frame)}`);
  }
  assert.deepEqual(presence.snapshot(), {});
}

// --- bounded against a hostile or buggy peer -------------------------------
{
  const presence = createEphemeralPresence();
  for (let i = 0; i < MAX_USERS_PER_CONVERSATION + 12; i += 1) {
    presence.note({ type: "typing", conversationId: "c", userId: `u${i}`, ttlMs: 20_000 });
  }
  assert.equal(presence.typingUserIds("c").length, MAX_USERS_PER_CONVERSATION, "typists per conversation are capped");
  for (let i = 0; i < MAX_CONVERSATIONS + 20; i += 1) {
    presence.note({ type: "typing", conversationId: `c${i}`, userId: "bob", ttlMs: 20_000 });
  }
  assert.equal(Object.keys(presence.snapshot()).length <= MAX_CONVERSATIONS, true, "conversations are capped");
}

// --- forget: a stopped panel shows nobody typing ---------------------------
{
  const presence = createEphemeralPresence();
  presence.note({ type: "typing", conversationId: "a", userId: "bob", ttlMs: 20_000 });
  presence.note({ type: "typing", conversationId: "b", userId: "eve", ttlMs: 20_000 });
  presence.forget("a");
  assert.deepEqual(Object.keys(presence.snapshot()), ["b"]);
  presence.forget();
  assert.deepEqual(presence.snapshot(), {}, "stopping clears every hint");
}

// --- transport: send + inbound dispatch ------------------------------------
{
  const sent = [];
  let handlers = {};
  const socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)), close() {},
    addEventListener: (event, fn) => { handlers[event] = fn; } };
  const ephemeral = [];
  const syncs = [];
  const client = createCollaborationRealtimeClient({
    sync: () => { syncs.push(1); return Promise.resolve(); },
    onEphemeral: (frame) => ephemeral.push(frame),
    createSocket: () => socket,
    setIntervalFn: () => 0, clearIntervalFn: () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {},
  });
  client.start();

  assert.equal(client.sendEphemeral({ type: "typing", conversationId: "c", ttlMs: 6_000 }), true);
  assert.deepEqual(sent.at(-1), { schemaVersion: 1, type: "typing", conversationId: "c", ttlMs: 6_000 },
    "the client stamps the schema version it was built against");

  // Inbound routing: durable hints still sync, ephemeral hints go up, and
  // anything else (including a version mismatch) is dropped.
  handlers.message({ data: JSON.stringify({ type: "sync.available", schemaVersion: 1, cursor: 4 }) });
  assert.equal(syncs.length, 1, "sync.available still triggers durable sync");
  handlers.message({ data: JSON.stringify({ type: "typing", schemaVersion: 1, conversationId: "c", userId: "bob", ttlMs: 6_000 }) });
  assert.equal(ephemeral.length, 1);
  assert.equal(ephemeral[0].userId, "bob", "the relayed frame names the origin");
  handlers.message({ data: JSON.stringify({ type: "typing", schemaVersion: 99, conversationId: "c", userId: "bob" }) });
  handlers.message({ data: JSON.stringify({ type: "realtime.error", schemaVersion: 1, code: "X" }) });
  handlers.message({ data: "not json" });
  assert.equal(ephemeral.length, 1, "a version mismatch, an error frame and garbage are all dropped");
  assert.equal(syncs.length, 1, "and none of them force a sync");

  // Best effort by contract: a closed socket is not an error.
  socket.readyState = 3;
  assert.equal(client.sendEphemeral({ type: "typing", conversationId: "c", ttlMs: 6_000 }), false);
  client.stop();
  socket.readyState = 1;
  assert.equal(client.sendEphemeral({ type: "typing", conversationId: "c", ttlMs: 6_000 }), false, "a stopped client publishes nothing");
}

console.log("collaboration-typing: ok");
