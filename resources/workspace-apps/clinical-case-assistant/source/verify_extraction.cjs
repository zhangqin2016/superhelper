#!/usr/bin/env node
"use strict";

/**
 * Extraction accuracy-hardening layer — ENGINE-AGNOSTIC and deterministic. This is
 * what turns "the VLM read something" into "a clinician can trust it in seconds":
 *
 *   1. validateFields  — deterministic checks no model should be trusted to do:
 *      date consistency, age sanity, sex/enum, ICD-10 format, lab value
 *      plausibility + unit presence, and diagnosis↔lab consistency.
 *   2. crossCheck      — dual-track consensus: compare two independent extractions
 *      (e.g. OCR track vs VLM track, or two model passes); agreement → trust,
 *      disagreement → conflict to review.
 *   3. verifyExtraction— fuse the above into per-field confidence (high/medium/low)
 *      and a REVIEW QUEUE so the physician only checks the uncertain ~fraction,
 *      not every field.
 *
 * Top-tier accuracy is mostly this layer, not the OCR engine — so it lives in code,
 * is unit-tested, and works regardless of which engine (RapidOCR/Qwen-VL/MinerU/
 * PaddleOCR-VL/TextIn) produced the extraction. Verified by
 * scripts/test-clinical-case-verify.mjs.
 */

const { annotateLabs, flagValue } = require("./emr_schema.cjs");

// Absolute physiologic bounds (much wider than the reference range) — a value
// outside this is almost certainly an OCR/extraction error, not a real result.
const LAB_PLAUSIBLE = {
  "白细胞": [0, 200], "中性粒细胞": [0, 200], "淋巴细胞": [0, 100],
  "血红蛋白": [0, 300], "血小板": [0, 3000], "钾": [1, 10],
};

// ICD-10 incl. Chinese GB extensions (D70.x04, I10.x00x031, D72.800x005, Z98.800x112).
const ICD_RE = /^[A-Za-z]\d{2}(\.[0-9xX]+)?$/;
const SEX_ENUM = new Set(["男", "女", "male", "female", "m", "f"]);

// diagnosis keyword → the lab + direction it implies (for consistency checks).
const DX_LAB_EXPECT = [
  { re: /白细胞减少/, lab: "白细胞", flag: "low" },
  { re: /血小板减少/, lab: "血小板", flag: "low" },
  { re: /中性粒细胞减少/, lab: "中性粒细胞", flag: "low" },
  { re: /淋巴细胞减少/, lab: "淋巴细胞", flag: "low" },
  { re: /贫血/, lab: "血红蛋白", flag: "low" },
  { re: /低钾/, lab: "钾", flag: "low" },
];

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function labKey(lab) {
  return `${lab.name}@${lab.date || "?"}`;
}

/** Deterministic validation. Returns [{ field, severity:"error"|"warn", message }]. */
function validateFields(c) {
  const issues = [];
  const enc = c?.encounter || {};
  const d = c?.demographics || {};

  // dates
  const adm = Date.parse(enc.admittedAt || "");
  const dis = Date.parse(enc.dischargedAt || "");
  if (enc.admittedAt && Number.isNaN(adm)) issues.push({ field: "encounter.admittedAt", severity: "warn", message: "入院日期无法解析" });
  if (enc.dischargedAt && Number.isNaN(dis)) issues.push({ field: "encounter.dischargedAt", severity: "warn", message: "出院日期无法解析" });
  if (!Number.isNaN(adm) && !Number.isNaN(dis) && adm > dis) issues.push({ field: "encounter", severity: "error", message: "入院日期晚于出院日期" });
  if (!Number.isNaN(adm) && !Number.isNaN(dis) && enc.lengthOfStayDays != null) {
    const span = Math.round((dis - adm) / 86400000);
    if (Math.abs(span - Number(enc.lengthOfStayDays)) > 1) issues.push({ field: "encounter.lengthOfStayDays", severity: "warn", message: `住院天数(${enc.lengthOfStayDays})与日期跨度(${span})不一致` });
  }

  // demographics
  const age = num(d.age);
  if (d.age != null && (age == null || age < 0 || age > 120)) issues.push({ field: "demographics.age", severity: "warn", message: "年龄超出合理范围" });
  if (d.sex && !SEX_ENUM.has(String(d.sex).toLowerCase())) issues.push({ field: "demographics.sex", severity: "warn", message: "性别取值异常" });

  // ICD format
  (c?.problems || []).forEach((p, i) => {
    if (p.icd && !ICD_RE.test(String(p.icd))) issues.push({ field: `problems[${i}].icd`, severity: "warn", message: `ICD 编码格式可疑：${p.icd}` });
  });

  // lab plausibility + unit
  (c?.labs || []).forEach((lab, i) => {
    const v = num(lab.value);
    if (v == null) { issues.push({ field: `labs[${i}]`, severity: "error", message: `化验值非数值：${lab.name} = ${lab.value}` }); return; }
    const bounds = LAB_PLAUSIBLE[lab.name];
    if (bounds && (v < bounds[0] || v > bounds[1])) issues.push({ field: `labs[${i}]`, severity: "error", message: `${lab.name} ${lab.value} 超出生理范围(疑似识别错误)` });
    if (!lab.unit) issues.push({ field: `labs[${i}]`, severity: "warn", message: `${lab.name} 缺少单位` });
  });

  // diagnosis ↔ lab consistency (only when the lab exists)
  const latest = new Map();
  for (const lab of annotateLabs(c?.labs || [], d.sex)) {
    const prev = latest.get(lab.name);
    if (!prev || String(lab.date || "") >= String(prev.date || "")) latest.set(lab.name, lab);
  }
  for (const p of c?.problems || []) {
    for (const exp of DX_LAB_EXPECT) {
      if (!exp.re.test(String(p.name || ""))) continue;
      const lab = latest.get(exp.lab);
      if (lab && lab.flag !== exp.flag && lab.flag !== "unknown") {
        issues.push({ field: "consistency", severity: "warn", message: `诊断「${p.name}」与化验不一致：${exp.lab} 当前为 ${lab.flag}，请核对` });
      }
    }
  }

  return issues;
}

/** Dual-track consensus: compare two independent extractions of the SAME case.
 *  Returns { agreements:Set<field>, conflicts:[{field,a,b}] }. */
function crossCheck(a, b) {
  const agreements = new Set();
  const conflicts = [];
  const cmp = (field, va, vb) => {
    if (va == null || vb == null) return;
    if (String(va).trim() === String(vb).trim()) agreements.add(field);
    else conflicts.push({ field, a: va, b: vb });
  };

  cmp("demographics.sex", a?.demographics?.sex, b?.demographics?.sex);
  cmp("demographics.age", a?.demographics?.age, b?.demographics?.age);
  cmp("encounter.admittedAt", a?.encounter?.admittedAt, b?.encounter?.admittedAt);
  cmp("encounter.dischargedAt", a?.encounter?.dischargedAt, b?.encounter?.dischargedAt);

  // problems: compare by ICD set
  const icdA = new Set((a?.problems || []).map((p) => p.icd).filter(Boolean));
  const icdB = new Set((b?.problems || []).map((p) => p.icd).filter(Boolean));
  for (const code of icdA) (icdB.has(code) ? agreements : { add() {} }).add(`problem:${code}`);
  for (const code of icdA) if (!icdB.has(code)) conflicts.push({ field: `problem:${code}`, a: "存在", b: "缺失" });
  for (const code of icdB) if (!icdA.has(code)) conflicts.push({ field: `problem:${code}`, a: "缺失", b: "存在" });

  // labs: compare value by name@date
  const mapB = new Map((b?.labs || []).map((l) => [labKey(l), l.value]));
  for (const l of a?.labs || []) {
    if (mapB.has(labKey(l))) cmp(`lab:${labKey(l)}`, l.value, mapB.get(labKey(l)));
  }

  return { agreements, conflicts };
}

/**
 * Fuse validation + consensus into per-field confidence + a review queue.
 * opts.second = a second independent extraction (optional). Returns:
 *   { issues, conflicts, fieldConfidence:{field:{level,score}}, reviewQueue:[], summary }
 */
function verifyExtraction(c, opts = {}) {
  const issues = validateFields(c);
  const { agreements, conflicts } = opts.second ? crossCheck(c, opts.second) : { agreements: new Set(), conflicts: [] };

  const errorFields = new Set(issues.filter((i) => i.severity === "error").map((i) => i.field));
  const warnFields = new Set(issues.filter((i) => i.severity === "warn").map((i) => i.field));
  const conflictFields = new Set(conflicts.map((c2) => c2.field));

  // Build the tracked field list (everything we can score).
  const fields = new Set([...agreements, ...conflictFields, ...errorFields, ...warnFields]);
  (c?.labs || []).forEach((l, i) => fields.add(`labs[${i}]`));
  (c?.problems || []).forEach((p, i) => p.icd && fields.add(`problems[${i}].icd`));
  for (const f of ["demographics.sex", "demographics.age", "encounter.admittedAt", "encounter.dischargedAt"]) fields.add(f);

  const fieldConfidence = {};
  for (const f of fields) {
    let score = 0.6, level = "medium";
    if (errorFields.has(f) || conflictFields.has(f)) { score = 0.2; level = "low"; }
    else if (warnFields.has(f)) { score = 0.45; level = "low"; }
    else if (agreements.has(f)) { score = 0.95; level = "high"; }
    fieldConfidence[f] = { level, score };
  }

  const reviewQueue = Object.entries(fieldConfidence)
    .filter(([, v]) => v.level === "low")
    .map(([field]) => ({ field, reason: errorFields.has(field) ? "校验未通过" : conflictFields.has(field) ? "双轨不一致" : "需确认" }));

  const levels = Object.values(fieldConfidence).map((v) => v.level);
  const summary = {
    fields: levels.length,
    high: levels.filter((l) => l === "high").length,
    medium: levels.filter((l) => l === "medium").length,
    low: levels.filter((l) => l === "low").length,
    needsReview: reviewQueue.length,
    hasErrors: errorFields.size > 0,
  };

  return { issues, conflicts, fieldConfidence, reviewQueue, summary };
}

module.exports = { validateFields, crossCheck, verifyExtraction, ICD_RE, LAB_PLAUSIBLE };
