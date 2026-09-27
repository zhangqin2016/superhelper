#!/usr/bin/env node
// Auto-mode in-pool failover. Field case 2026-09-27: auto pool [claude, deepseek],
// claude's upstream went silent; the old failover re-sent 13 times to claude
// because the retry re-pinned the source turn's model. The failover must name
// the escaped model EXPLICITLY, be hard-bounded, and never fire for manual picks
// or side-effecting turns. [gate: auto-model-health-failover]
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...require(p), ...exports } };
};

let selection = { mode: "auto", autoPoolMode: "custom", autoModelIds: ["custom-claude", "custom-deepseek"] };
let sideEffectFree = true;
const models = () => [
  { id: "custom-claude", providerID: "pc", modelID: "claude-opus-5-5", capabilities: { toolCall: true } },
  { id: "custom-deepseek", providerID: "pd", modelID: "DeepSeek-V4.1-Flash", capabilities: { toolCall: true } },
  { id: "custom-unselected", providerID: "pu", modelID: "other", capabilities: { toolCall: true } },
];
stub("../src/main/model-selection-catalog.js", {
  getSessionModelSelection: () => selection,
  listModelSelectionPublic: () => ({ selection, models: require("../src/main/model-availability.js").annotateModelOptions(models()) }),
});
stub("../src/main/tool-call-rescue.js", { isSideEffectFreeToolRun: () => sideEffectFree });
stub("../src/main/runner-live-config.js", { terminateIdleRunners: () => {} });

const availability = require("../src/main/model-availability.js");
const { createTurnRecoveryRuntime } = require("../src/main/turn-recovery-runtime.js");

const sends = [];
const emits = [];
const makeRuntime = () => createTurnRecoveryRuntime({
  ctx: {
    sessionManager: {
      findById: () => ({ id: "s1" }),
      getLastUserMessage: () => ({ content: "设计个复杂任务", files: [] }),
      getTurnInputByTurnId: () => null,
    },
    runnerPool: { get: () => ({ isBusy: () => false }) },
  },
  getState: () => ({ turnId: null, queue: [], tools: new Map() }),
  emit: (...args) => emits.push(args),
  sendUserMessage: async (sessionId, text, files, opts) => { sends.push(opts); return { ok: true, turnId: `t${sends.length + 1}` }; },
});
const claudeRoute = { mode: "auto", selectionId: "custom-claude", modelId: "claude-opus-5-5", providerId: "pc", selection };
let runtime = null;
const fail = (route = claudeRoute, code = "MODEL_NO_RESPONSE") => runtime.maybeSelfHealAndRetry("s1", { code, retryable: true, modelRoute: route });

let n = 0; const check = async (name, fn) => { availability.resetModelAvailabilityForTests(); runtime = makeRuntime(); sends.length = 0; emits.length = 0; await fn(); n++; console.log(`ok - ${name}`); };

await check("a failed auto turn fails over, naming the escaped model explicitly", async () => {
  await fail();
  assert.equal(sends.length, 1, "exactly one retry is sent");
  assert.deepEqual(sends[0].avoidModelIds, ["custom-claude"], "the retry excludes the model that failed");
  assert.ok(availability.getModelAvailability({ providerID: "pc", modelID: "claude-opus-5-5" }), "the failed model is marked");
  assert.equal(emits.at(-1)[1], "turn.model_failover");
  assert.equal(emits.at(-1)[3]?.turnId, "t2", "the notice is emitted against the retry turn, not dropped as an orphan");
});

await check("failover is hard-bounded — the 13-resend loop cannot recur", async () => {
  // Pretend routing kept landing on claude anyway: failures keep coming.
  for (let i = 0; i < 12; i++) await fail(claudeRoute, "ENGINE_RESULT_FAILED");
  assert.ok(sends.length >= 1, "the first failure does fail over");
  assert.ok(sends.length <= 1, `at most one failover while the only alternative is untried (got ${sends.length})`);
});

await check("when every selected alternative is also marked, it stops and surfaces the failure", async () => {
  availability.noteModelFailure({ providerID: "pd", modelID: "DeepSeek-V4.1-Flash" }, { code: "RATE_LIMITED" });
  await fail();
  assert.equal(sends.length, 0, "no retry when no healthy SELECTED alternative exists");
});

await check("an unselected model is never used as a failover target", async () => {
  selection = { mode: "auto", autoPoolMode: "custom", autoModelIds: ["custom-claude"] };
  await fail({ ...claudeRoute, selection });
  assert.equal(sends.length, 0, "a single-model pool has nothing to fail over to — custom-unselected is never picked");
  selection = { mode: "auto", autoPoolMode: "custom", autoModelIds: ["custom-claude", "custom-deepseek"] };
});

await check("a manual pick is never failed over", async () => {
  await fail({ ...claudeRoute, mode: "manual" });
  assert.equal(sends.length, 0);
  selection = { mode: "manual", autoPoolMode: "custom", autoModelIds: ["custom-claude", "custom-deepseek"], manualModelId: "custom-claude" };
  await fail();
  assert.equal(sends.length, 0, "user switched to manual since the source turn");
  selection = { mode: "auto", autoPoolMode: "custom", autoModelIds: ["custom-claude", "custom-deepseek"] };
});

await check("a turn that ran side-effecting tools is not replayed", async () => {
  sideEffectFree = false;
  await fail();
  assert.equal(sends.length, 0);
  sideEffectFree = true;
});

await check("a non-model failure never triggers failover", async () => {
  await fail(claudeRoute, "INTERRUPTED");
  assert.equal(sends.length, 0);
  await fail(); // positive control on the same fresh runtime
  assert.equal(sends.length, 1, "the same runtime does fail over on a model failure");
});

await check("kill switch disables failover", async () => {
  process.env.LILY_MODEL_HEALTH_ROUTING = "0";
  await fail();
  delete process.env.LILY_MODEL_HEALTH_ROUTING;
  assert.equal(sends.length, 0);
});

console.log(`\nauto-model-failover: ok (${n} checks)`);
