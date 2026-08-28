#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLongTaskWakeHandler, wakeTurnId } = require("../src/main/long-task/session-wakeup.js");
const calls = [];
const ctx = {
  sessionManager: {
    findById: (id) => id === "session-a" ? { id, projectId: "project-a" } : null,
    resolveTurnOwnerScope: () => ({ ok: true, ownerScope: "owner-a" }),
  },
  turnOrchestrator: {
    sendUserMessage: async (...args) => { calls.push(args); return { ok: true, queued: true }; },
  },
};
const handler = createLongTaskWakeHandler(ctx);
const wake = { id: "wake:job-a", jobId: "job-a", turnId: "turn-a", sessionId: "session-a", projectId: "project-a", ownerScope: "owner-a" };
const job = { ...wake, id: "job-a", outputFiles: ["/tmp/result.pdf"] };
assert.deepEqual(await handler(wake, job), { ok: true, duplicate: false });
assert.equal(calls.length, 1);
assert.equal(calls[0][3].recordUser, false);
assert.equal(calls[0][3].queueVisibility, "background");
assert.equal(calls[0][3].durableQueueKey, wake.id);
assert.equal(calls[0][3].turnId, wakeTurnId(wake.id));
assert.equal(calls[0][3].sourceTurnId, job.turnId);
assert.match(calls[0][3].engineText, /result\.pdf/);

const wrongOwner = createLongTaskWakeHandler({
  ...ctx,
  sessionManager: { ...ctx.sessionManager, resolveTurnOwnerScope: () => ({ ok: true, ownerScope: "owner-b" }) },
});
assert.deepEqual(await wrongOwner(wake, job), { ok: false, permanent: true, error: "OWNER_SCOPE_CHANGED" });
assert.equal(calls.length, 1, "scope mismatch cannot dispatch into another principal's session");
assert.equal((await handler(wake, { ...job, turnId: "foreign-turn" })).error, "JOB_SCOPE_CHANGED");
assert.equal((await handler(wake, { ...job, sessionId: "foreign-session" })).error, "JOB_SCOPE_CHANGED");
assert.equal(calls.length, 1);

console.log("long-task-session-wakeup: ok");
