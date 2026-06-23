#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createOpencodeSdkSession,
  unwrapSdkResult,
  unwrapSdkPageResult,
} = require("../src/main/runtime/opencode-sdk-session.js");

const calls = [];
const client = {
  session: {
    get: async (params) => {
      calls.push(["session.get", params]);
      return { data: { id: params.sessionID } };
    },
    create: async (params) => {
      calls.push(["session.create", params]);
      return { data: { id: "ses_new" } };
    },
    promptAsync: async (params) => {
      calls.push(["session.promptAsync", params]);
      return { data: null };
    },
    status: async (params) => {
      calls.push(["session.status", params]);
      return { data: { ses_1: { type: "idle" } } };
    },
    messages: async (params) => {
      calls.push(["session.messages", params]);
      return {
        data: [{ info: { id: "msg_1" }, parts: [] }],
        response: { headers: { get: (name) => (name === "x-next-cursor" ? "cursor_2" : null) } },
      };
    },
    abort: async (params) => {
      calls.push(["session.abort", params]);
      return { data: true };
    },
    revert: async (params) => {
      calls.push(["session.revert", params]);
      return { data: true };
    },
    unrevert: async (params) => {
      calls.push(["session.unrevert", params]);
      return { data: true };
    },
  },
  permission: {
    reply: async (params) => {
      calls.push(["permission.reply", params]);
      return { data: true };
    },
  },
  question: {
    reply: async (params) => {
      calls.push(["question.reply", params]);
      return { data: true };
    },
  },
  global: {
    health: async () => {
      calls.push(["global.health", {}]);
      return { data: { healthy: true } };
    },
  },
};

const sdkSession = createOpencodeSdkSession(client, "/workspace/app");
assert.deepEqual(await sdkSession.get("ses_1"), { id: "ses_1" });
assert.deepEqual(await sdkSession.create({ agent: "build" }), { id: "ses_new" });
await sdkSession.promptAsync("ses_1", {
  agent: "build",
  model: { providerID: "lily", modelID: "deepseek" },
  parts: [{ type: "text", text: "hello" }],
});
assert.deepEqual(await sdkSession.status(), { ses_1: { type: "idle" } });
const messagesPage = await sdkSession.messages("ses_1", { limit: 20, before: "cursor_1" });
assert.deepEqual(messagesPage.data, [{ info: { id: "msg_1" }, parts: [] }]);
assert.equal(messagesPage.response.headers.get("x-next-cursor"), "cursor_2");
await sdkSession.abort("ses_1");
await sdkSession.revert("ses_1", "msg_1");
await sdkSession.unrevert("ses_1");
await sdkSession.respondPermission("ses_1", "perm_1", { reply: "once", message: "ok" });
await sdkSession.respondQuestion("q_1", [["A"]]);
assert.deepEqual(await sdkSession.health(), { healthy: true });

assert.deepEqual(calls, [
  ["session.get", { directory: "/workspace/app", sessionID: "ses_1" }],
  ["session.create", { directory: "/workspace/app", agent: "build" }],
  ["session.promptAsync", {
    directory: "/workspace/app",
    sessionID: "ses_1",
    agent: "build",
    model: { providerID: "lily", modelID: "deepseek" },
    parts: [{ type: "text", text: "hello" }],
  }],
  ["session.status", { directory: "/workspace/app" }],
  ["session.messages", { directory: "/workspace/app", sessionID: "ses_1", limit: 20, before: "cursor_1" }],
  ["session.abort", { directory: "/workspace/app", sessionID: "ses_1" }],
  ["session.revert", { directory: "/workspace/app", sessionID: "ses_1", messageID: "msg_1" }],
  ["session.unrevert", { directory: "/workspace/app", sessionID: "ses_1" }],
  ["permission.reply", {
    directory: "/workspace/app",
    requestID: "perm_1",
    reply: "once",
    message: "ok",
  }],
  ["question.reply", {
    directory: "/workspace/app",
    requestID: "q_1",
    answers: [["A"]],
  }],
  ["global.health", {}],
]);

assert.equal(unwrapSdkResult({ data: 42 }, "x"), 42);
assert.deepEqual(unwrapSdkPageResult({ data: [1], response: "r" }, "x"), { data: [1], response: "r" });
assert.throws(
  () => unwrapSdkResult({ error: { message: "bad" } }, "x"),
  /x failed: bad/,
);

console.log("opencode-sdk-session: ok");
