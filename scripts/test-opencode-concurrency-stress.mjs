#!/usr/bin/env node
/**
 * Stress the shared-serve demux without a live model: many sessions in the same
 * directory, interleaved events, unowned directory diagnostics, and session-less
 * deltas after message ownership is learned. This is the regression shape that
 * makes multi-session desktop usage feel stable.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const handlers = [];
const shared = {
  onEvent(fn) {
    handlers.push(fn);
    return () => {};
  },
};

function manager(sessionID) {
  const m = new OpencodeServerManager({
    serverCommand: "/bin/true",
    cwd: "/workspace",
    dataDir: ":memory:",
  });
  m.sessionID = sessionID;
  m._shared = shared;
  const seen = [];
  m.on("event", (event) => seen.push(event));
  m.subscribe();
  return { m, seen };
}

const sessions = Array.from({ length: 5 }, (_, i) => manager(`ses_${i}`));

function emit(event, directory = "/workspace") {
  for (const handler of handlers) handler(directory, event);
}

// Directory diagnostics from bad workspace skills are noisy but not turn-owned.
for (let i = 0; i < 10; i++) {
  emit({
    type: "session.error",
    properties: { error: { data: { message: `Failed to parse skill /workspace/.claude/skills/bad${i}/SKILL.md` } } },
  });
}
assert(sessions.every(({ seen }) => seen.length === 0), "directory diagnostics are not delivered to any session");

// Turn-affecting events without ownership must fail closed. They can mutate the
// live UI, so broadcasting them would make same-directory sessions appear mixed.
emit({
  type: "todo.updated",
  properties: { todos: [{ content: "wrong session", status: "in_progress" }] },
});
assert(sessions.every(({ seen }) => seen.length === 0), "unowned turn updates are not delivered to any session");

// Establish one message per session.
for (let i = 0; i < sessions.length; i++) {
  emit({
    type: "message.part.updated",
    properties: {
      part: {
        sessionID: `ses_${i}`,
        messageID: `msg_${i}`,
        id: `prt_${i}`,
        type: "text",
        text: "",
      },
    },
  });
}

for (let i = 0; i < sessions.length; i++) {
  assert(sessions[i].seen.length === 1, `session ${i} receives only its ownership event`);
}

// Now session-less deltas should route by learned messageID only.
for (let round = 0; round < 20; round++) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    emit({
      type: "message.part.delta",
      properties: { messageID: `msg_${i}`, partID: `prt_${i}`, field: "text", delta: `${i}:${round};` },
    });
  }
}

for (let i = 0; i < sessions.length; i++) {
  const deltas = sessions[i].seen.filter((event) => event.type === "message.part.delta");
  assert(deltas.length === 20, `session ${i} receives its 20 deltas`);
  assert(deltas.every((event) => event.properties.messageID === `msg_${i}`), `session ${i} has no cross-session deltas`);
}

// A real owned error still reaches only its owner.
emit({
  type: "session.error",
  properties: { sessionID: "ses_3", error: { data: { message: "real owned failure" } } },
});
assert(sessions[3].seen.at(-1)?.type === "session.error", "owned error reaches owner");
assert(sessions.filter(({ seen }) => seen.at(-1)?.type === "session.error").length === 1,
  "owned error does not leak to other sessions");

console.log("opencode-concurrency-stress: ok");
