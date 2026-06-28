#!/usr/bin/env node
// Clinical Case Assistant — extraction choke-point `finalizeCase`. Pure logic.
// WHY (Rule 13): extraction is the ONE place where raw PHI legitimately enters
// (the scan is the model input). So the invariant that matters is: whatever raw
// object comes out of the model, finalizeCase returns a DE-IDENTIFIED, validated,
// rendered case — never the raw PHI. This test pins that invariant.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "resources/workspace-apps/clinical-case-assistant/source");
const { finalizeCase, parseCaseJson, EXTRACTION_PROMPT } = require(path.join(SRC, "extract_case.cjs"));

const FAKE_ID = "110101195203078888";
// Simulates exactly what the vision model returns: raw, PHI-bearing.
const modelOutput = {
  schemaVersion: 1,
  caseId: "13343209",
  idNumber: FAKE_ID,
  patientName: "测试患者",
  demographics: { patientName: "测试患者", sex: "女", age: 74, phone: "13900008888" },
  problems: [{ name: "干燥综合征", icd: "M35.000", rank: "primary" }],
  labs: [{ name: "白细胞", value: 1.89, unit: "10^9/L", date: "2026-05-08" }],
};

const result = finalizeCase(modelOutput, { salt: "s" });
const blob = JSON.stringify(result.case);

assert.equal(result.ok, true, "a clean extraction validates ok");
assert.ok(!blob.includes(FAKE_ID) && !blob.includes("测试患者") && !blob.includes("13900008888"), "finalizeCase returns DE-IDENTIFIED data — raw PHI never survives extraction");
assert.ok(result.case.patientKey && result.case.idNumber === undefined, "raw id folded into patientKey");
assert.ok(blob.includes("干燥综合征") && blob.includes("M35.000"), "clinical content preserved");
assert.ok(result.card.includes("非诊断结论"), "a card is produced with the safety footer");
assert.ok(result.audit.dropped > 0, "audit reports removed PHI");
assert.ok(result.verification && result.verification.summary, "extraction result carries accuracy-verification (confidence + review queue)");
assert.equal(result.needsReview, result.verification.summary.needsReview > 0, "needsReview reflects the verification review queue");

// a second (dual-track) extraction that disagrees marks fields for review
const dual = finalizeCase(modelOutput, { salt: "s", second: { ...modelOutput, demographics: { ...modelOutput.demographics, age: 47 } } });
assert.ok(dual.verification.conflicts.some((c) => c.field === "demographics.age"), "dual-track disagreement becomes a conflict");
assert.ok(dual.needsReview, "a dual-track conflict flags the case for review");

// fail-safe: garbage in → does not crash, does not fabricate
assert.equal(finalizeCase(null).ok, false, "empty extraction returns not-ok, not a fake case");
assert.equal(parseCaseJson("the model refused"), null, "non-JSON model output parses to null (caller fails loud, no fabrication)");
assert.ok(parseCaseJson('prefix {"schemaVersion":1} suffix')?.schemaVersion === 1, "JSON embedded in prose is recovered");

// the extraction prompt instructs raw copy + per-timepoint labs (so de-id can catch PHI)
assert.ok(EXTRACTION_PROMPT.includes("脱敏") && EXTRACTION_PROMPT.includes("不要合并") && EXTRACTION_PROMPT.includes("不要编造"), "prompt: copy raw, keep labs per-timepoint, do not fabricate");

console.log("clinical-case-extract: ok");
