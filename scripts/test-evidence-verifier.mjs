#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildVerifierMessages,
  parseVerdict,
  verifyAnswer,
  makeChatCaller,
  unsupportedClaimsHint,
} = require("../src/main/evidence-verifier.js");

// --- prompt shape -----------------------------------------------------------
{
  const { system, user } = buildVerifierMessages({ answer: "共 27,448 条", evidenceText: "wc -l => 100" });
  assert.match(system, /strict fact-checker/i, "system frames a strict fact-check");
  assert.match(system, /UNSUPPORTED/, "system defines unsupported");
  assert.match(user, /EVIDENCE/, "user carries the evidence");
  assert.match(user, /27,448/, "user carries the answer");
}

// --- verdict parsing (tolerant + fail-open) ---------------------------------
assert.deepEqual(parseVerdict('{"unsupported":["数据共 27448 条","阿语覆盖率 39%"]}').unsupported.length, 2, "parses a JSON verdict");
assert.equal(parseVerdict('{"unsupported":[]}').ok, true, "empty unsupported = ok");
assert.equal(parseVerdict("preamble... {\"unsupported\":[\"x\"]} trailing").unsupported[0], "x", "finds JSON amid prose");
assert.equal(parseVerdict("garbage not json").ok, true, "unparseable => ok (never invents unsupported claims)");
assert.equal(parseVerdict("").ok, true, "empty => ok");

// --- verifyAnswer: supported vs unsupported ---------------------------------
{
  // model says everything is supported
  const okVerdict = await verifyAnswer({
    answer: "文件有 100 行。",
    evidenceText: "wc -l file => 100",
    callModel: async () => '{"unsupported":[]}',
  });
  assert.equal(okVerdict.ok, true, "grounded answer passes");
  assert.equal(okVerdict.degraded, false, "not degraded when the verifier answered");

  // model flags a fabricated number
  const badVerdict = await verifyAnswer({
    answer: "共 27,448 条记录,阿语覆盖率 39%。",
    evidenceText: "(no count was ever computed)",
    callModel: async () => '{"unsupported":["共 27,448 条记录","阿语覆盖率 39%"]}',
  });
  assert.equal(badVerdict.ok, false, "ungrounded numeric claims are flagged");
  assert.equal(badVerdict.unsupported.length, 2, "both fabricated claims returned");
}

// --- FAIL OPEN: verifier errors/timeout never block ------------------------
{
  const thrown = await verifyAnswer({ answer: "x", evidenceText: "y", callModel: async () => { throw new Error("boom"); } });
  assert.equal(thrown.ok, true, "a throwing verifier => ok (fail open)");
  assert.equal(thrown.degraded, true, "marked degraded so the caller can fall back to the regex gate");

  const slow = await verifyAnswer({ answer: "x", evidenceText: "y", timeoutMs: 1_000, callModel: () => new Promise(() => {}) });
  assert.equal(slow.ok, true, "a hung verifier times out => ok (fail open)");
  assert.equal(slow.degraded, true, "timeout is degraded, not a block");

  assert.equal((await verifyAnswer({ answer: "x", callModel: null })).degraded, true, "no caller => degraded");
  assert.equal((await verifyAnswer({ answer: "", callModel: async () => "{}" })).degraded, true, "empty answer => nothing to verify");
}

// --- makeChatCaller: needs a complete endpoint ------------------------------
assert.equal(makeChatCaller({ baseUrl: "", model: "m" }), null, "no baseUrl => no caller (degrade)");
assert.equal(makeChatCaller({ baseUrl: "https://x/y", model: "" }), null, "no model => no caller");
assert.equal(typeof makeChatCaller({ baseUrl: "https://x/llm/v1", apiKey: "k", model: "deepseek" }), "function", "complete endpoint => a caller");

// --- specific corrective hint names the exact unsupported claims ------------
{
  const hint = unsupportedClaimsHint(["共 27,448 条记录", "阿语覆盖率 39%"], true);
  assert.match(hint, /27,448/, "zh hint names the unsupported claim");
  assert.match(hint, /先用工具逐条核实/, "zh hint tells the model to verify");
  const en = unsupportedClaimsHint(["record count 27448"], false);
  assert.match(en, /NOT supported/, "en hint states the claims are unsupported");
  assert.equal(unsupportedClaimsHint([]), "", "no unsupported claims => no hint");
}

console.log("evidence-verifier: ok");
