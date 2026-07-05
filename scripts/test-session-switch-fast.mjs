import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const {
  scheduleSessionRunnerWarmup,
  switchSessionFast,
} = require("../src/main/ipc-sessions");

function createCtx() {
  const sessions = new Map([
    ["s1", { id: "s1", projectId: "p1" }],
    ["s2", { id: "s2", projectId: "p1" }],
  ]);
  const ctx = {
    ensureCalls: [],
    sessionManager: {
      activeSessionId: null,
      findById(id) {
        return sessions.get(id) || null;
      },
      switchTo(id) {
        this.activeSessionId = id;
      },
    },
    projectManager: {
      activeProjectId: "p1",
      getActive() {
        return { id: this.activeProjectId };
      },
      switchTo(id) {
        this.activeProjectId = id;
      },
    },
    runnerPool: {
      has() {
        return false;
      },
    },
    ensureSessionRunner(_ctx, sessionId, opts) {
      ctx.ensureCalls.push({ sessionId, opts });
      return { runner: { isAlive: () => false } };
    },
  };
  return ctx;
}

{
  const ctx = createCtx();
  const result = switchSessionFast(ctx, "s1");
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s1");
  assert.equal(ctx.sessionManager.activeSessionId, "s1");
  assert.deepEqual(ctx.ensureCalls, [], "session switch must not synchronously prepare the runner");
  await delay(20);
  assert.deepEqual(ctx.ensureCalls, [], "background warmup should leave the first local page load room to run");
  await delay(180);
  assert.equal(ctx.ensureCalls.length, 1, "active switched session is warmed in the background");
  assert.equal(ctx.ensureCalls[0].sessionId, "s1");
  assert.equal(ctx.ensureCalls[0].opts.spawn, false);
}

{
  const ctx = createCtx();
  assert.equal(scheduleSessionRunnerWarmup(ctx, "s1"), true);
  assert.equal(scheduleSessionRunnerWarmup(ctx, "s1"), false, "duplicate warmups are coalesced");
  ctx.sessionManager.switchTo("s1");
  await delay(200);
  assert.equal(ctx.ensureCalls.length, 1);
}

{
  const ctx = createCtx();
  const result = switchSessionFast(ctx, "s1");
  assert.equal(result.ok, true);
  ctx.sessionManager.switchTo("s2");
  await delay(200);
  assert.deepEqual(ctx.ensureCalls, [], "stale background warmup must not prepare a no-longer-active session");
}

{
  const ctx = createCtx();
  const result = switchSessionFast(ctx, "missing");
  assert.equal(result.ok, false);
  assert.equal(result.error, "NOT_FOUND");
  assert.deepEqual(ctx.ensureCalls, []);
}

console.log("session switch fast tests passed");
