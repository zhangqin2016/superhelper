import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

// Regression counterpart of /private/tmp/lily-model-review-repros.cjs.
const require = createRequire(import.meta.url);
const { createTurnAdmissionMethods } = require("../src/main/turn-admission-runtime.js");
const source = fs.readFileSync(new URL("../src/main/turn-steer-runtime.js", import.meta.url), "utf8");
const noop = () => {};
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function harness(blockedStage, accepted = true) {
  const gate = deferred();
  const entered = deferred();
  const state = {
    phase: "running", turnId: "turn-A", turnGeneration: 1,
    admittedTurnInput: { turnId: "turn-A", ownerScope: "owner" },
    dispatchAttemptId: "attempt-A", characterWorldsSnapshot: null,
    enginePayload: { allowImageFileParts: false },
    finalizing: false, terminalEmitted: false, queue: [],
  };
  const injections = [], commits = [], evidence = [], notices = [], events = [], stages = [];
  state.evidenceLedger = {
    recordVisionObservation: value => evidence.push({ target: state.turnId, value }),
    recordDocumentExtraction: value => evidence.push({ target: state.turnId, value }),
  };
  const runner = {
    isBusy: () => true,
    async steer(payload) {
      injections.push({ target: state.turnId, payload });
      if (blockedStage === "delivery") { entered.resolve(); await gate.promise; }
      return accepted;
    },
  };
  let currentRunner = runner;
  const preflight = stage => async (text, files, options) => {
    stages.push(stage);
    if (stage === blockedStage) { entered.resolve(); await gate.promise; }
    options.emitNotice({ stage });
    return { ok: true, text: `${text}:${stage}`, files: [], [`${stage}Evidence`]: { stage } };
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    require(id) {
      if (id === "./turn-active-phase") return require("../src/main/turn-active-phase.js");
      if (id === "./send-preflight") return {
        runVisionPreflight: preflight("vision"), runDocumentPreflight: preflight("document"),
      };
      throw Error(`Unexpected dependency: ${id}`);
    },
  });
  const session = { id: "s1" };
  const deps = { appendTimelineNotice: noop, log: { warn: noop }, mergeDisplayFileMetadata: files => files };
  const ctx = {
    ...module.exports.createTurnSteerMethods(deps),
    ...createTurnAdmissionMethods({ ...deps, newQueueId: () => "queued", queueDispatchOptions: opts => opts }),
    _state: () => state, states: new Map([[session.id, state]]),
    ctx: { runnerPool: { get: () => currentRunner }, sessionManager: { findById: () => session } },
    transcriptStore: { commitUserMessage: (id, message) => commits.push(message) },
    _emitEngineNotice: (id, notice) => notices.push(notice),
    _emit: (...args) => events.push(args), _emitQueue: noop,
    _admitQueuedTurn: () => ({ ok: true, turn: { turnId: "queued-turn" } }),
  };
  const replaceTurn = () => Object.assign(state, {
    turnId: "turn-B", turnGeneration: 2, dispatchAttemptId: "attempt-B",
    admittedTurnInput: { turnId: "turn-B", ownerScope: "owner" },
  });
  return { ctx, state, session, gate, entered, injections, commits, evidence, notices, events, stages,
    replaceTurn, replaceRunner: () => { currentRunner = { ...runner }; } };
}

const invalidations = {
  turn: h => h.replaceTurn(),
  generation: h => { h.state.turnGeneration += 1; },
  runner: h => h.replaceRunner(),
  attempt: h => { h.state.dispatchAttemptId = "attempt-B"; },
  owner: h => { h.state.admittedTurnInput.ownerScope = "other-owner"; },
  state: h => h.ctx.states.set("s1", { ...h.state }),
  finalizing: h => { h.state.finalizing = true; },
  terminal: h => { h.state.terminalEmitted = true; },
  snapshot: h => { h.state.characterWorldsSnapshot = {}; },
};
for (const stage of ["vision", "document"]) {
  for (const [name, invalidate] of Object.entries(invalidations)) {
    test(`${stage} preflight: changed ${name} cannot receive stale steer, evidence or notices`, { timeout: 2000 }, async () => {
      const h = harness(stage);
      const pending = h.ctx._trySteer(h.session, "correction for A", [{ path: "/virtual/A.pdf" }]);
      await h.entered.promise;
      const before = { evidence: h.evidence.length, notices: h.notices.length };
      invalidate(h);
      h.gate.resolve();
      assert.equal((await pending).ok, false, "unaccepted stale work must use the original queue fallback");
      assert.equal(h.injections.length, 0);
      assert.equal(h.commits.length, 0);
      assert.equal(h.events.length, 0);
      assert.equal(h.evidence.length, before.evidence);
      assert.equal(h.notices.length, before.notices);
      if (stage === "vision") assert.deepEqual(h.stages, ["vision"]);
    });
  }

  test(`${stage} preflight race queues the original input exactly once`, { timeout: 2000 }, async () => {
    const h = harness(stage);
    const files = [{ path: "/virtual/A.pdf", sourcePath: "/virtual/live-A.pdf" }];
    const opts = { mode: "steer", modelSelection: { mode: "manual", manualModelId: "model-A" } };
    const pending = h.ctx.sendUserMessage("s1", "correction for A", files, opts);
    await h.entered.promise;
    h.replaceTurn();
    h.gate.resolve();
    const result = await pending;
    assert.equal(result.steerFellBack, true);
    assert.equal(result.queued, true);
    assert.equal(h.state.queue.length, 1);
    assert.equal(h.state.queue[0].text, "correction for A");
    assert.deepEqual(plain(h.state.queue[0].files), files);
    assert.deepEqual(plain(h.state.queue[0].options), opts);
    assert.equal(h.injections.length, 0);
    assert.equal(h.commits.length, 0);
    assert.equal(h.evidence.some(value => value.target === "turn-B"), false);
  });
}

test("unchanged claim preserves enriched delivery, evidence and original history", async () => {
  const h = harness();
  const files = [{ path: "/virtual/A.pdf" }];
  const result = await h.ctx._trySteer(h.session, "correction for A", files);
  assert.equal(result.steered, true);
  assert.equal(result.turnId, "turn-A");
  assert.equal(h.injections[0].payload.text, "correction for A:vision:document");
  assert.deepEqual(plain(h.injections[0].payload.files), []);
  assert.equal(h.injections[0].payload.allowImageFileParts, false);
  assert.equal(h.evidence.length, 2);
  assert.equal(h.commits[0].text, "correction for A");
  assert.deepEqual(plain(h.commits[0].files), files);
});

test("accepted delivery losing its claim remains orphaned, never requeued or committed", async () => {
  const h = harness("delivery");
  const pending = h.ctx._trySteer(h.session, "correction for A", []);
  await h.entered.promise;
  h.replaceTurn();
  h.gate.resolve();
  const result = await pending;
  assert.equal(result.steerOrphaned, true);
  assert.equal(result.turnId, "turn-A");
  assert.equal(h.injections.length, 1);
  assert.equal(h.commits.length, 0);
  assert.equal(h.events.length, 0);
});
