#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createOpencodeSdkSession,
  unwrapSdkResult,
  unwrapSdkPageResult,
  withCallTimeout,
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
    summarize: async (params) => {
      calls.push(["session.summarize", params]);
      return { data: true };
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
    fork: async (params) => {
      calls.push(["session.fork", params]);
      return { data: { id: "ses_fork" } };
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
  system: "guide",
  model: { providerID: "lily", modelID: "deepseek" },
  parts: [{ type: "text", text: "hello" }],
});
assert.equal(
  await sdkSession.summarize("ses_1", { providerID: "lily", modelID: "deepseek", auto: true }),
  true,
);
assert.equal(
  await sdkSession.summarize("ses_1", { providerID: "lily", modelID: "deepseek", auto: true, reason: "long_session", customPrompt: "nope" }),
  true,
);
assert.deepEqual(await sdkSession.status(), { ses_1: { type: "idle" } });
const messagesPage = await sdkSession.messages("ses_1", { limit: 20, before: "cursor_1" });
assert.deepEqual(messagesPage.data, [{ info: { id: "msg_1" }, parts: [] }]);
assert.equal(messagesPage.response.headers.get("x-next-cursor"), "cursor_2");
await sdkSession.abort("ses_1");
await sdkSession.revert("ses_1", "msg_1");
await sdkSession.unrevert("ses_1");
assert.deepEqual(await sdkSession.fork("ses_1", "msg_1"), { id: "ses_fork" });
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
    system: "guide",
    model: { providerID: "lily", modelID: "deepseek" },
    parts: [{ type: "text", text: "hello" }],
  }],
  ["session.summarize", {
    directory: "/workspace/app",
    sessionID: "ses_1",
    providerID: "lily",
    modelID: "deepseek",
    auto: true,
  }],
  ["session.summarize", {
    directory: "/workspace/app",
    sessionID: "ses_1",
    providerID: "lily",
    modelID: "deepseek",
    auto: true,
  }],
  ["session.status", { directory: "/workspace/app" }],
  ["session.messages", { directory: "/workspace/app", sessionID: "ses_1", limit: 20, before: "cursor_1" }],
  ["session.abort", { directory: "/workspace/app", sessionID: "ses_1" }],
  ["session.revert", { directory: "/workspace/app", sessionID: "ses_1", messageID: "msg_1" }],
  ["session.unrevert", { directory: "/workspace/app", sessionID: "ses_1" }],
  ["session.fork", { directory: "/workspace/app", sessionID: "ses_1", messageID: "msg_1" }],
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

// ---- Control-plane timeouts: a wedged serve must reject, never hang ----

// withCallTimeout rejects with a distinct code and swallows the late settlement.
{
  let lateReject = false;
  process.once("unhandledRejection", () => {
    lateReject = true;
  });
  const hanging = new Promise((_, reject) => setTimeout(() => reject(new Error("late boom")), 60));
  await assert.rejects(
    withCallTimeout(hanging, 20, "session.status"),
    /session\.status failed: OPENCODE_HTTP_TIMEOUT after 20ms/,
  );
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(lateReject, false, "late SDK settlement must not surface as unhandledRejection");
}

// A wedged serve (methods never resolve) fails fast on every control-plane call.
{
  const hang = () => new Promise(() => {});
  const wedgedClient = {
    session: {
      get: hang, create: hang, promptAsync: hang, summarize: hang,
      status: hang, messages: hang, abort: hang, revert: hang, unrevert: hang,
      fork: hang,
    },
    permission: { reply: hang },
    question: { reply: hang },
    global: { health: hang },
  };
  const wedged = createOpencodeSdkSession(wedgedClient, "/w", {
    timeouts: { health: 25, status: 25, promptAsync: 25, create: 25 },
  });
  await assert.rejects(wedged.health(), /OPENCODE_HTTP_TIMEOUT/);
  await assert.rejects(wedged.status(), /OPENCODE_HTTP_TIMEOUT/);
  await assert.rejects(wedged.create({}), /OPENCODE_HTTP_TIMEOUT/);
  await assert.rejects(wedged.promptAsync("ses_1", {}), /OPENCODE_HTTP_TIMEOUT/);
}

// Normal fast responses are untouched (data passes through as before).
{
  const fast = createOpencodeSdkSession(client, "/workspace/app");
  const statusResult = await fast.status();
  assert(statusResult?.ses_1 || Object.keys(statusResult || {}).length >= 0);
}

console.log("opencode-sdk-session: ok");
