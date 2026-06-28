#!/usr/bin/env node
// Clinical Case Assistant — reasoning safety shell: red flags + retrieval + advice
// assembly. Pure logic; the model is injected as a stub so the SAFETY invariants
// are tested deterministically.
// WHY (Rule 13): this is the layer that could "get dumber" or unsafe. The tests
// pin: critical values are caught by code and surface on top even when the model
// is silent; ungrounded suggestions are dropped; no similar case → abstain, not
// guess; the not-a-diagnosis footer is always present.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "resources/workspace-apps/clinical-case-assistant/source");
const { detectRedFlags, renderRedFlags } = require(path.join(SRC, "red_flags.cjs"));
const { retrieveSimilar } = require(path.join(SRC, "retrieve_cases.cjs"));
const { assembleAdvice, enforceEvidence, buildAdvice, NON_DIAGNOSIS_FOOTER } = require(path.join(SRC, "advise.cjs"));

// --- red flags: deterministic, severity-ordered ---------------------------------
const sick = {
  caseId: "Q",
  demographics: { sex: "女", age: 74 },
  vitals: { bpSys: 185, bpDia: 100 },
  labs: [
    { name: "中性粒细胞", value: 0.4, unit: "10^9/L", date: "2026-05-09" }, // critical: 粒缺
    { name: "中性粒细胞", value: 1.0, unit: "10^9/L", date: "2026-05-01" }, // older, ignored
    { name: "白细胞", value: 1.89, unit: "10^9/L", date: "2026-05-09" },    // high
    { name: "血小板", value: 71, unit: "10^9/L", date: "2026-05-09" },       // not a red flag (>50)
  ],
  problems: [{ name: "I型呼吸衰竭", icd: "J96.900x002" }],
};
const flags = detectRedFlags(sick);
assert.equal(flags[0].severity, "critical", "粒细胞缺乏 surfaces as the top critical flag");
assert.ok(flags[0].label.includes("粒细胞缺乏"), "critical flag is agranulocytosis");
assert.ok(flags.some((f) => f.label.includes("重度白细胞减少")), "WBC<2.0 flagged");
assert.ok(flags.some((f) => f.label.includes("血压")), "BP≥180/110 flagged");
assert.ok(flags.some((f) => f.label.includes("呼吸衰竭")), "problem-list keyword flagged");
assert.ok(!flags.some((f) => f.basis.includes("血小板 71")), "platelet 71 is NOT a red flag (>50 threshold)");
assert.ok(renderRedFlags(flags).startsWith("## 🚩"), "red flags render with the priority header");
assert.equal(renderRedFlags([]), "", "no flags → empty block");

// uses the LATEST neutrophil value, not the older one
assert.ok(flags.find((f) => f.label.includes("粒细胞缺乏")).basis.includes("0.4"), "red flag uses the most recent value");

// --- retrieval: clinical similarity + abstention --------------------------------
const library = [
  { caseId: "A", demographics: { sex: "女", age: 72 }, problems: [{ name: "干燥综合征", icd: "M35.000" }, { name: "白细胞减少", icd: "D70.x04" }], labs: [{ name: "白细胞", value: 2.0, unit: "10^9/L" }, { name: "血小板", value: 80, unit: "10^9/L" }] },
  { caseId: "B", demographics: { sex: "男", age: 30 }, problems: [{ name: "骨折", icd: "S72" }], labs: [] },
];
const query = { caseId: "Q2", demographics: { sex: "女", age: 74 }, problems: [{ name: "干燥综合征", icd: "M35.000" }], labs: [{ name: "白细胞", value: 1.89, unit: "10^9/L" }, { name: "血小板", value: 71, unit: "10^9/L" }] };
const ret = retrieveSimilar(query, library);
assert.equal(ret.hits[0].case.caseId, "A", "the clinically similar case ranks first");
assert.ok(ret.hasRelevant, "a strong match marks the library as relevant");
assert.ok(ret.hits[0].reasons.some((r) => r.includes("编码")), "similarity explains itself (shared ICD)");

const noMatch = retrieveSimilar({ caseId: "Z", demographics: { sex: "男", age: 25 }, problems: [{ name: "阑尾炎", icd: "K35" }], labs: [] }, library);
assert.equal(noMatch.hasRelevant, false, "no clinically similar case → hasRelevant false (advice will abstain)");

// --- evidence enforcement -------------------------------------------------------
const ev = enforceEvidence([
  { point: "考虑干燥综合征相关血细胞减少", evidenceRefs: ["病例A"], uncertainty: "需自身抗体确认" },
  { point: "这条没有证据", evidenceRefs: [] },
]);
assert.equal(ev.kept.length, 1, "only evidence-backed suggestions are kept");
assert.equal(ev.dropped.length, 1, "ungrounded suggestion is dropped");

// --- assembly: red flags on top, footer always, abstain still shows flags -------
const stubModel = async () => ({
  differentials: [{ point: "干燥综合征相关三系减少可能", evidenceRefs: ["病例A", "白细胞趋势"], uncertainty: "需排除药物/EBV" }],
  workup: [{ point: "建议查抗SSA/SSB、ANA、骨髓涂片", evidenceRefs: ["相似病例A诊疗"] }],
  monitoring: [{ point: "监测血常规与感染征象", evidenceRefs: ["粒细胞减少"] }, { point: "无依据的随访建议", evidenceRefs: [] }],
});
const adv = await buildAdvice({ ...query, vitals: { bpSys: 185 }, labs: [{ name: "中性粒细胞", value: 0.4, unit: "10^9/L" }, ...query.labs] }, library, stubModel);
assert.ok(adv.markdown.indexOf("🚩") < adv.markdown.indexOf("参考方向"), "red flags appear BEFORE the model's suggestions");
assert.ok(adv.markdown.includes("【证据：") , "kept suggestions show their evidence");
assert.ok(adv.markdown.includes("已隐去 1 条无证据"), "ungrounded monitoring suggestion is removed and noted");
assert.ok(adv.markdown.includes(NON_DIAGNOSIS_FOOTER), "non-diagnosis footer always present");
assert.ok(adv.markdown.includes("相似病例（出处）"), "similar cases listed as provenance");

// abstain path STILL shows red flags + footer, and never fabricates advice
const abstain = await buildAdvice({ caseId: "Z2", demographics: { sex: "男", age: 25 }, problems: [{ name: "阑尾炎", icd: "K35" }], labs: [{ name: "血小板", value: 15, unit: "10^9/L" }] }, library, stubModel);
assert.ok(abstain.abstained, "no similar case → abstained");
assert.ok(abstain.markdown.includes("信息不足"), "abstention says 信息不足, does not invent advice");
assert.ok(abstain.markdown.includes("🚩") && abstain.markdown.includes("重度血小板减少"), "red flags STILL surface even when advice abstains");
assert.ok(abstain.markdown.includes(NON_DIAGNOSIS_FOOTER), "footer present on abstention too");

// model failure degrades safely (no crash, flags + footer remain)
const advNullModel = await buildAdvice(query, library, async () => { throw new Error("model down"); });
assert.ok(advNullModel.markdown.includes(NON_DIAGNOSIS_FOOTER), "model failure → still returns a safe, footer-bearing result");

console.log("clinical-case-reasoning: ok");
