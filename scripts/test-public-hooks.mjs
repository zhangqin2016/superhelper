#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPublicHookRuntime, redactHookValue } = require("../src/main/public-hooks.js");

const audits = [];
let commandEvent = null;
const runtime = createPublicHookRuntime({
  executors: {
    command: async (_hook, event) => {
      commandEvent = event;
      return { allow: true, reason: `ok:${event.type}` };
    },
    http: async () => { throw new Error("offline"); },
    prompt: async () => ({ allow: false, reason: "policy denied", contextAppend: "bounded context" }),
    agent: async () => new Promise(() => {}),
    mcp: async () => ({ unexpected: "ignored" }),
  },
  emitAudit: (event) => audits.push(event),
  now: () => 100,
});

runtime.register({ id: "observe-http", event: "turn.completed", type: "http", mode: "observe", timeoutMs: 20 });
runtime.register({ id: "security-prompt", event: "tool.before", type: "prompt", mode: "security", timeoutMs: 20, canMutate: true });
runtime.register({ id: "slow-agent", event: "tool.before", type: "agent", mode: "observe", timeoutMs: 10 });
runtime.register({ id: "command-ok", event: "turn.admitted", type: "command", mode: "observe", timeoutMs: 20, inputSchema: { fields: ["sessionId"] } });

const observed = await runtime.run("turn.completed", { sessionId: "s1", apiKey: "secret-value" });
assert.equal(observed.allow, true, "observation hooks fail open");
assert.equal(observed.failures.length, 1);

const denied = await runtime.run("tool.before", { sessionId: "s1", tool: "shell" });
assert.equal(denied.allow, false, "security hook decision fails closed");
assert.equal(denied.reason, "policy denied");
assert.equal(denied.contextAppend, "bounded context");
assert.ok(denied.failures.some((item) => item.code === "PUBLIC_HOOK_TIMEOUT"), "timed-out observation hooks are audited");

const admitted = await runtime.run("turn.admitted", { sessionId: "s1" });
assert.equal(admitted.allow, true);
assert.equal(admitted.results[0].reason, "ok:turn.admitted");
assert.deepEqual(commandEvent.payload, { sessionId: "s1" }, "declared input schema limits hook visibility");

await assert.rejects(
  runtime.run("turn.admitted", { sessionId: "s1" }, { chain: ["command-ok"] }),
  /PUBLIC_HOOK_RECURSION/,
);
assert.throws(() => runtime.register({ id: "bad", event: "unknown", type: "command" }), /PUBLIC_HOOK_EVENT_INVALID/);
assert.throws(
  () => runtime.register({ id: "unsafe-policy", event: "tool.before", type: "command", authority: "security", failurePolicy: "open" }),
  /PUBLIC_HOOK_FAILURE_POLICY_INVALID/,
);

const redacted = redactHookValue({ token: "abc", nested: { password: "xyz", safe: "yes" } });
assert.equal(redacted.token, "[REDACTED]");
assert.equal(redacted.nested.password, "[REDACTED]");
assert.equal(redacted.nested.safe, "yes");
assert.ok(audits.length >= 4);
assert.ok(audits.every((event) => !JSON.stringify(event).includes("secret-value")), "audit never includes raw secrets");

console.log("public-hooks: ok");
