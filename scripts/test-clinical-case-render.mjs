#!/usr/bin/env node
// Clinical Case Assistant — case card renderer. Pure logic, no model/network.
// WHY (Rule 9/13): the card is what the clinician reads, so it must (a) show lab
// trends with the DETERMINISTIC ↑/↓, (b) always carry the "not a diagnosis"
// footer, and (c) never print PHI even if some leaked into the object
// (defense-in-depth: the renderer reads only whitelisted clinical fields).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "resources/workspace-apps/clinical-case-assistant/source");
const { renderCaseMarkdown, SAFETY_FOOTER } = require(path.join(SRC, "render_case.cjs"));
const { deidentifyCase } = require(path.join(SRC, "deidentify.cjs"));

// Synthetic (fabricated) case — never a real patient.
const rawCase = {
  schemaVersion: 1,
  caseId: "ENC-1",
  patientName: "测试患者",
  demographics: { patientName: "测试患者", sex: "女", age: 74, phone: "13900008888" },
  encounter: { department: "风湿免疫科", admittedAt: "2026-05-08", dischargedAt: "2026-05-27", lengthOfStayDays: 19 },
  problems: [
    { name: "白细胞减少", icd: "D70.x04", rank: "primary" },
    { name: "干燥综合征", icd: "M35.000", rank: "secondary" },
  ],
  labs: [
    { name: "白细胞", value: 1.89, unit: "10^9/L", date: "2026-05-08" },
    { name: "白细胞", value: 2.80, unit: "10^9/L", date: "2026-04-24" },
    { name: "血小板", value: 71, unit: "10^9/L", date: "2026-05-08" },
  ],
  imaging: [{ modality: "腹部彩超", finding: "脂肪肝；胆总管扩张" }],
  specialty: { findings: ["双侧腕关节、膝关节压痛"] },
  history: { past: ["高血压2年", "10年前胆囊切除术"], medications: ["贝尼地平"], allergies: [] },
};

// Render the DE-IDENTIFIED case (the only thing the app ever renders).
const { deidentified } = deidentifyCase(rawCase, { salt: "s" });
const md = renderCaseMarkdown(deidentified);

// time series: sorted by date, with deterministic flags
assert.ok(md.includes("白细胞"), "lab name present");
assert.ok(/2026-04-24 2\.8↓ → 2026-05-08 1\.89↓/.test(md), "WBC trend sorted by date with ↓ flags");
assert.ok(md.includes("71↓"), "platelet flagged low");
assert.ok(md.includes("参考 3.5–9.5"), "reference range shown");

// problem list + primary tag
assert.ok(md.includes("1. 白细胞减少 (D70.x04) 【主要】"), "primary diagnosis tagged");
assert.ok(md.includes("干燥综合征 (M35.000)"), "secondary diagnosis listed");

// imaging / specialty / history
assert.ok(md.includes("脂肪肝") && md.includes("膝关节压痛") && md.includes("贝尼地平"), "imaging/specialty/meds rendered");

// mandatory safety footer
assert.ok(md.includes(SAFETY_FOOTER) && md.includes("非诊断结论"), "card always carries the not-a-diagnosis footer");

// defense-in-depth: NO PHI in the rendered card
assert.ok(!md.includes("测试患者") && !md.includes("13900008888"), "no PHI appears in the rendered card");

console.log("clinical-case-render: ok");
