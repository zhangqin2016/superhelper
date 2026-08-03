#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAgentRuntimeControlServer } = require("../src/main/agent-runtime-control-server.js");
const { createDesktopRuntimeTransport, createLilyClient } = require("../src/sdk/index.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-control-"));
const controlFile = path.join(dir, "control.json");
const events = [];
const observers = new Set();
const session = { id: "session-1", projectId: "project-1", title: "CLI" };
const ctx = {
  sessionManager: {
    findById: (id) => id === session.id ? session : null,
    getRuntimeEvents: (_id, { afterSeq }) => events.filter((event) => event.seq > afterSeq),
    _store: () => ({ getLastRuntimeEventSeq: () => events.at(-1)?.seq || 0 }),
  },
  projectManager: { projects: [{ id: "project-1", path: dir }] },
  eventBus: {
    addObserver(fn) { observers.add(fn); return () => observers.delete(fn); },
  },
  turnOrchestrator: {
    async sendUserMessage(sessionId, prompt, _files, options) {
      assert.equal(sessionId, session.id);
      if (options.mode === "steer") return { ok: true, steered: true };
      events.push({ id: "e1", type: "turn.started", sessionId, turnId: "turn-1", seq: 1, ts: 1, payload: { prompt } });
      events.push({ id: "e2", type: "turn.completed", sessionId, turnId: "turn-1", seq: 2, ts: 2, payload: { assistant: "done" } });
      for (const observer of observers) observer(sessionId, events);
      return { ok: true, turnId: "turn-1" };
    },
    _state: () => ({ turnId: "turn-1", taskRun: { id: "run-1" } }),
    snapshot: () => ({ phase: "idle", turnId: null, taskRun: null }),
    interrupt: async () => ({ ok: true, interrupted: true }),
  },
};

const server = createAgentRuntimeControlServer(ctx, {
  discoveryPath: controlFile,
  token: "control-secret",
  authorize: async () => ({ ok: true }),
});
try {
  await server.start();
  assert.equal(fs.statSync(controlFile).mode & 0o777, 0o600);
  const transport = createDesktopRuntimeTransport({ controlFile });
  assert.equal(await transport.available(), true);
  const client = createLilyClient({ transport });
  const streamed = [];
  for await (const event of client.run({ prompt: "hello", sessionId: session.id, workspace: dir })) streamed.push(event);
  assert.deepEqual(streamed.map((event) => event.type), ["turn.started", "turn.completed"]);
  assert.equal(streamed[1].cursor, 2);
  assert.equal((await client.steer(session.id, "new direction")).steered, true);
  assert.equal((await client.cancel(session.id)).interrupted, true);
  const resumed = [];
  for await (const event of client.resume({ sessionId: session.id, afterCursor: 1 })) resumed.push(event);
  assert.deepEqual(resumed.map((event) => event.type), ["turn.completed"], "cursor resume does not replay older events");
} finally {
  await server.stop();
  assert.equal(fs.existsSync(controlFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("agent-runtime-control-server: ok");
