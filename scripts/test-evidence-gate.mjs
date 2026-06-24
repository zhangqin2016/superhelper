#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assessFinalAnswerEvidence,
  appendEvidenceGateNotice,
} = require("../src/main/evidence-gate.js");

const policy = { required: true };

const unsupported = assessFinalAnswerEvidence({
  assistant: "问题已经修复，根因是连接池配置错误。",
  evidencePolicy: policy,
});
assert.equal(unsupported.ok, false);
assert.equal(unsupported.reason, "strong_claim_without_evidence");
assert.match(appendEvidenceGateNotice("问题已经修复。", unsupported), /证据门槛/);

const withToolEvidence = assessFinalAnswerEvidence({
  assistant: "问题已经修复。",
  evidencePolicy: policy,
  toolCount: 1,
});
assert.equal(withToolEvidence.ok, true, "tool activity is evidence that the model observed concrete state");

const withTextEvidence = assessFinalAnswerEvidence({
  assistant: "原因是超时。证据：src/main/foo.js:12 的超时配置和测试输出。",
  evidencePolicy: policy,
});
assert.equal(withTextEvidence.ok, true, "explicit evidence markers satisfy the gate");

const casual = assessFinalAnswerEvidence({
  assistant: "你好，有什么可以帮你？",
  evidencePolicy: { required: false },
});
assert.equal(casual.ok, true);

console.log("evidence-gate: ok");
