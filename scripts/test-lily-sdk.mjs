#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  EXIT_CODES,
  createLilyClient,
  decodeRuntimeEventLine,
  encodeRuntimeEvent,
} = require("../src/sdk/index.js");

const calls = [];
const transport = {
  async *run(input) {
    calls.push(["run", input]);
    yield { type: "turn.started", cursor: 1, payload: { text: input.prompt } };
    yield { type: "turn.completed", cursor: 2, payload: { assistant: "done" } };
  },
  async cancel(id) { calls.push(["cancel", id]); return true; },
  async steer(id, text) { calls.push(["steer", id, text]); return true; },
  async checkpoint(id) { calls.push(["checkpoint", id]); return { id: "cp-1" }; },
};

const client = createLilyClient({ transport });
const events = [];
for await (const event of client.run({
  prompt: "hello",
  workspace: "/tmp",
  allowedTools: ["read"],
  deniedTools: ["bash"],
  maxTurns: 12,
})) events.push(event);
assert.deepEqual(events.map((event) => event.type), ["turn.started", "turn.completed"]);
assert.equal(events[0].protocolVersion, 1);
assert.equal(events[0].cursor, 1);
assert.deepEqual(calls[0][1].allowedTools, ["read"]);
assert.equal(await client.cancel("task-1"), true);
assert.equal(await client.steer("task-1", "change direction"), true);
assert.deepEqual(await client.checkpoint("task-1"), { id: "cp-1" });
assert.throws(() => client.run({ prompt: "" }), /LILY_SDK_PROMPT_REQUIRED/);

const line = encodeRuntimeEvent({ type: "task.completed", cursor: 7, ts: 123, payload: { ok: true } });
assert.equal(line.endsWith("\n"), true);
assert.deepEqual(decodeRuntimeEventLine(line).payload, { ok: true });
assert.throws(() => decodeRuntimeEventLine("not-json"), /LILY_SDK_EVENT_INVALID/);
assert.equal(EXIT_CODES.SUCCESS, 0);
assert.equal(EXIT_CODES.USER_INPUT_REQUIRED, 10);
assert.equal(EXIT_CODES.PERMISSION_DENIED, 11);
assert.equal(EXIT_CODES.CANCELLED, 12);
assert.equal(EXIT_CODES.RUNTIME_UNAVAILABLE, 20);
assert.equal(EXIT_CODES.TASK_FAILED, 30);

console.log("lily-sdk: ok");
