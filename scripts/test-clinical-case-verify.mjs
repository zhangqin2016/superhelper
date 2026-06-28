#!/usr/bin/env node
// Clinical Case Assistant — extraction accuracy-hardening layer. Pure, engine-agnostic.
// WHY (Rule 9/13): top-tier accuracy comes from this deterministic layer, not the
// OCR engine. The tests pin: implausible values/bad dates are caught as errors;
// real Chinese-extended ICD codes are accepted; diagnosis↔lab inconsistency is
// flagged; dual-track disagreements become conflicts; and only uncertain fields
// land in the review queue (so the physician checks few, not all).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "resources/workspace-apps/clinical-case-assistant/source");
const { validateFields, crossCheck, verifyExtraction, ICD_RE } = require(path.join(SRC, "verify_extraction.cjs"));

// --- ICD-10 incl. real Chinese GB extensions from the source document -----------
for (const code of ["D70.x04", "I10.x00x031", "D72.800x005", "M35.000", "Z98.800x112", "K76.807"]) {
  assert.ok(ICD_RE.test(code), `real ICD code must validate: ${code}`);
}
for (const bad of ["ZZZ", "123", "M3"]) assert.ok(!ICD_RE.test(bad), `malformed ICD rejected: ${bad}`);

// --- deterministic validators ---------------------------------------------------
const bad = {
  encounter: { admittedAt: "2026-05-27", dischargedAt: "2026-05-08", lengthOfStayDays: 19 }, // admit > discharge
  demographics: { sex: "X", age: 200 },
  problems: [{ name: "白细胞减少", icd: "NOPE" }],
  labs: [
    { name: "白细胞", value: 9999, unit: "10^9/L", date: "2026-05-08" }, // implausible
    { name: "血小板", value: 71, date: "2026-05-08" },                    // missing unit
  ],
};
const issues = validateFields(bad);
const msg = JSON.stringify(issues);
assert.ok(issues.some((i) => i.severity === "error" && i.field === "encounter"), "admit>discharge is an error");
assert.ok(issues.some((i) => i.field === "demographics.age" && i.severity === "warn"), "age 200 warned");
assert.ok(issues.some((i) => i.field === "demographics.sex"), "bad sex warned");
assert.ok(issues.some((i) => /ICD/.test(i.message)), "bad ICD warned");
assert.ok(issues.some((i) => i.severity === "error" && /超出生理范围/.test(i.message)), "implausible WBC 9999 is an error");
assert.ok(issues.some((i) => /缺少单位/.test(i.message)), "missing unit warned");
// diagnosis 白细胞减少 but WBC 9999 (not low) → consistency warn
assert.ok(issues.some((i) => i.field === "consistency"), "diagnosis↔lab inconsistency flagged");

// a clean case has no errors
const clean = {
  encounter: { admittedAt: "2026-05-08", dischargedAt: "2026-05-27", lengthOfStayDays: 19 },
  demographics: { sex: "女", age: 74 },
  problems: [{ name: "白细胞减少", icd: "D70.x04" }],
  labs: [{ name: "白细胞", value: 1.89, unit: "10^9/L", date: "2026-05-08" }],
};
assert.ok(!validateFields(clean).some((i) => i.severity === "error"), "clean case has no errors");

// --- dual-track consensus -------------------------------------------------------
const trackA = { demographics: { sex: "女", age: 74 }, problems: [{ icd: "D70.x04" }, { icd: "M35.000" }], labs: [{ name: "白细胞", value: 1.89, date: "2026-05-08" }] };
const trackB = { demographics: { sex: "女", age: 47 }, problems: [{ icd: "D70.x04" }], labs: [{ name: "白细胞", value: 8.9, date: "2026-05-08" }] };
const cc = crossCheck(trackA, trackB);
assert.ok(cc.agreements.has("demographics.sex"), "matching sex is an agreement");
assert.ok(cc.conflicts.some((c) => c.field === "demographics.age"), "age 74 vs 47 is a conflict");
assert.ok(cc.conflicts.some((c) => c.field === "lab:白细胞@2026-05-08"), "WBC 1.89 vs 8.9 is a lab conflict");
assert.ok(cc.conflicts.some((c) => c.field === "problem:M35.000"), "a diagnosis present in only one track is a conflict");

// --- verifyExtraction: confidence + review queue --------------------------------
const v = verifyExtraction(trackA, { second: trackB });
assert.equal(v.fieldConfidence["demographics.sex"].level, "high", "consensus-agreed field is high confidence");
assert.equal(v.fieldConfidence["demographics.age"].level, "low", "conflicting field is low confidence");
assert.ok(v.reviewQueue.some((r) => r.field === "demographics.age" && r.reason === "双轨不一致"), "conflict lands in review queue with reason");
assert.ok(v.summary.high >= 1 && v.summary.low >= 1, "summary counts confidence tiers");

// single-extraction (no second track): errors still drive the review queue
const v1 = verifyExtraction(bad);
assert.ok(v1.summary.hasErrors, "errors surfaced without a second track");
assert.ok(v1.reviewQueue.length > 0, "bad fields queued for physician review");
// a fully clean single extraction needs little/no review
const vClean = verifyExtraction(clean);
assert.ok(vClean.reviewQueue.length === 0, "clean extraction → empty review queue (physician checks nothing)");

console.log("clinical-case-verify: ok");
