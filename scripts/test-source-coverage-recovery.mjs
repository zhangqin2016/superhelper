#!/usr/bin/env node
// A partially-read attachment gets READ, not apologised for.
//
// The platform detects the shortfall (evidence ledger: coverage "partial" with
// observed/total) and every one of the five consumers only described it. It
// continues a turn for every other recoverable shortfall it finds — unfinished
// todos, an unconfirmed required tool, a claimed file that is not on disk, a
// silent model — so an attachment the model got halfway through was the one
// detected, recoverable shortfall with no recovery. Field case: a 3 MB .docx,
// 23 tool steps, and the user got a refusal instead of the analysis.
// [gate: attachment-content-grounding]
// Run: node scripts/test-source-coverage-recovery.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const recovery = require("../src/main/source-coverage-recovery.js");
const rescue = require("../src/main/tool-call-rescue.js");
const { evaluateAnswerEvidence } = require("../src/main/answer-evidence-finalizer.js");
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const partialSummary = (observed, total) => ({
  counts: { sourceContentSources: total },
  hasSourceContentEvidence: true,
  sourceContentCoverage: { status: "partial", observedCount: observed, sourceCount: total },
});

check("the decision uses the structured counts, never the answer's wording", () => {
  const base = {
    taskContract: { taskType: "content_extraction" },
    assistant: "读到的章节提出了三阶段架构。",
    evidenceSummary: partialSummary(12, 40),
  };
  const go = recovery.shouldReadRemainingSources(base);
  assert.equal(go.ok, true);
  assert.deepEqual([go.observed, go.total], [12, 40], "and carries how much is left, for the instruction");
  // Nothing about the phrasing changes the decision — that was the failure mode
  // of the first fix, which read the answer's prose to guess its coverage.
  for (const assistant of ["完整展示了全部内容。", "只看了一点点。", "x"]) {
    assert.equal(recovery.shouldReadRemainingSources({ ...base, assistant }).ok, true, assistant);
  }
});

check("a retry costs the user a round, so it is refused whenever it cannot help", () => {
  const base = {
    taskContract: { taskType: "content_extraction" },
    assistant: "answer",
    evidenceSummary: partialSummary(12, 40),
  };
  const reasons = {
    already_recovery: { ...base, recoveryAttempt: true },
    attempts_exhausted: { ...base, attempts: 1 },
    not_extraction: { ...base, taskContract: { taskType: "code_change" } },
    no_answer_to_extend: { ...base, assistant: "   " },
    nothing_left_to_read: { ...base, evidenceSummary: partialSummary(40, 40) },
    coverage_not_partial: { ...base, evidenceSummary: { sourceContentCoverage: { status: "complete" } } },
    disabled: { ...base, env: { LILY_SOURCE_COVERAGE_RETRY: "0" } },
  };
  for (const [reason, input] of Object.entries(reasons)) {
    const verdict = recovery.shouldReadRemainingSources(input);
    assert.equal(verdict.ok, false, reason);
    assert.equal(verdict.reason, reason);
  }
  assert.equal(recovery.shouldReadRemainingSources({}).ok, false, "and an empty call never retries");
});

check("the instruction is about finishing a file, not about researching the web", () => {
  for (const language of ["zh", "en"]) {
    const hint = recovery.buildSourceCoverageHint({ language, observed: 12, total: 40 });
    assert.ok(hint.includes("12/40"), "it says how much is left");
    assert.match(hint, language === "zh" ? /继续调用|抽取|解析/ : /extraction|parsing/i, "and to keep reading");
    assert.match(hint, language === "zh" ? /不要.*推测/ : /Do not infer/i, "and not to guess the rest");
    assert.match(hint, language === "zh" ? /必须保留/ : /must be kept/i, "and that supported conclusions survive");
    // The external-fact recovery hint is six steps of research discipline; none
    // of it applies to a file already sitting on disk.
    assert.ok(!/websearch|webfetch/i.test(hint), "and it is not the research hint");
  }
});

check("it rides the existing retry route — one more code, not a second mechanism", () => {
  const strategy = rescue.rescueStrategyFor("SOURCE_COVERAGE_INCOMPLETE");
  assert.ok(strategy, "the code resolves to a strategy");
  assert.equal(strategy.kind, "source_coverage_retry");
  assert.equal(strategy.enabled(), true);
  assert.equal(Number(strategy.maxAttempts) || 1, 1, "one follow-up round, never a chain");

  const finalizer = fs.readFileSync(new URL("../src/main/turn-terminal-finalizer.js", import.meta.url), "utf8");
  assert.match(finalizer, /triggerSourceCoverageRetry\s*\?\s*\n?\s*"SOURCE_COVERAGE_INCOMPLETE"/, "the terminal finalizer dispatches the code");
  assert.match(finalizer, /sourceCoverage,/, "and passes the counts the instruction needs");
  assert.match(finalizer, /suppressParentClosure:[^;]*triggerSourceCoverageRetry/, "and suppresses the generic closure while the round runs");

  const runtime = fs.readFileSync(new URL("../src/main/turn-recovery-runtime.js", import.meta.url), "utf8");
  assert.match(runtime, /strategy\.kind === "source_coverage_retry"/, "the runtime selects its hint");
  // The round must CONTINUE, not restart. Without the inherited evidence it
  // re-reads the sources already read and, when the shortfall came from a hard
  // limit, stops in exactly the same place — a round spent to arrive back where
  // it started, after which the user gets the same scope note anyway.
  assert.match(
    runtime,
    /evidenceContext: strategy\.kind === "evidence_verify_retry" \|\| strategy\.kind === "source_coverage_retry"/,
    "and passes the inherited evidence through",
  );
  assert.match(finalizer, /triggerVerifyRetry \|\| triggerSourceCoverageRetry\n?\s*\? buildEvidenceRecoveryContext/, "which the terminal finalizer builds for it");
  for (const language of ["zh", "en"]) {
    const hint = recovery.buildSourceCoverageHint({ language, observed: 12, total: 40 });
    assert.match(hint, language === "zh" ? /不要重读/ : /do not read it again/i, "and the instruction says not to redo it");
  }
  assert.match(runtime, /strategy\.kind === "source_coverage_retry" \|\| documentRecovery/, "and keeps the prior answer until the round supersedes it");
});

check("the finalizer asks for the round and still delivers an answer either way", () => {
  const userText = "这份文档讲了什么";
  const taskContract = buildTaskContract({ text: userText, files: [{ name: "proposal.docx", isImage: false }] });
  const result = evaluateAnswerEvidence({
    assistant: "文档里我读到的章节提出了三阶段架构。",
    taskContract,
    turnPolicy: buildTurnPolicy({ text: userText, taskContract }),
    evidenceSummary: partialSummary(12, 40),
    inputFiles: [{ name: "proposal.docx", isImage: false }],
    userText,
  });
  // Whether or not the round is requested, the user is never left with nothing:
  // the answer stands with its scope disclosed.
  assert.match(result.assistant, /三阶段架构/, "the analysis of what was read survives");
  assert.match(result.assistant, /只解析了附件的部分内容/, "with the scope stated");
  assert.equal(typeof result.triggerSourceCoverageRetry, "boolean", "and the trigger is always reported");
  if (result.triggerSourceCoverageRetry) {
    assert.deepEqual(result.sourceCoverage, { observed: 12, total: 40 }, "with the counts the instruction needs");
  }
});

check("only an actual overclaim is erased — a negated or self-disclosing answer is not", () => {
  const userText = "这份文档讲了什么";
  const taskContract = buildTaskContract({ text: userText, files: [{ name: "proposal.docx", isImage: false }] });
  const run = (assistant) => evaluateAnswerEvidence({
    assistant,
    taskContract,
    turnPolicy: buildTurnPolicy({ text: userText, taskContract }),
    evidenceSummary: partialSummary(12, 40),
    inputFiles: [{ name: "proposal.docx", isImage: false }],
    userText,
  }).assistant;

  // The claim this branch exists for: totality asserted over pages nobody saw.
  assert.ok(!run("图片完整展示了三个产品及全部价格。").includes("三个产品"), "an overclaim is still replaced");

  // A totality word NEGATED is the opposite of an overclaim, and an answer that
  // already states its own scope cannot be claiming the whole source. Matching
  // the word alone erased both — the second one is an answer being honest about
  // the very shortfall the branch exists to catch, which is worse than the
  // confabulation it was written to stop.
  for (const honest of [
    "文档没有完整列出所有字段，我只看到前 12 页。",
    "这份材料未能完整解析，以下只覆盖读到的部分。",
    "文档里我读到的章节提出了三阶段架构。",
  ]) {
    assert.ok(run(honest).includes(honest.slice(0, 8)), `an honest answer survives: ${honest}`);
  }

  // The disclosure question has one definition, asked of the gate rather than
  // kept as a second copy of its pattern.
  const gate = require("../src/main/evidence-gate.js");
  assert.equal(typeof gate.disclosesPartialSourceScope, "function");
  assert.equal(gate.disclosesPartialSourceScope("只解析了部分内容"), true);
  assert.equal(gate.disclosesPartialSourceScope("全文已完整解析"), false);
});

check("the round actually inherits what was read — the previous fix was a no-op", () => {
  const { buildEvidenceRecoveryContext } = require("../src/main/turn-recovery-context.js");
  const tools = [
    { name: "lily_file_intelligence", status: "done", result: { output: "pages 1-12 …" }, input: { action: "extract" } },
    { name: "write", status: "done", result: { output: "wrote" }, input: { filePath: "/a.txt", content: "x" } },
    { name: "bash", status: "done", result: { output: "done" }, input: { command: "rm -rf /tmp/x" } },
  ];
  const inherited = buildEvidenceRecoveryContext({ sourceTurnId: "t1", tools, evidenceScope: "source_content" });
  // Measured before the fix: null. sanitizeEvidenceTool required replay-safety,
  // which answers "is it safe to RUN again" — the wrong question when nothing is
  // re-run — and the extraction tools are not classified replay-safe, so every
  // observation was dropped before its kind was looked at.
  assert.ok(inherited, "the coverage round inherits something at all");
  assert.deepEqual(inherited.tools.map((t) => t.name), ["lily_file_intelligence"], "namely the read, and only the read");
  assert.equal(inherited.mode, "source_coverage_retry");
  assert.ok(/pages 1-12/.test(inherited.tools[0].result), "with the content it actually observed");

  // An ACTION's result must never ride along: inheriting a write would let the
  // model believe this turn already wrote the file.
  for (const name of ["write", "bash"]) {
    assert.ok(!inherited.tools.some((t) => t.name === name), `${name} is not an observation`);
  }
  // The external path keeps its stricter test, unchanged.
  assert.equal(buildEvidenceRecoveryContext({ sourceTurnId: "t1", tools, evidenceScope: "external" }), null);
});

console.log(`\n${checks} checks passed (source coverage recovery)`);
