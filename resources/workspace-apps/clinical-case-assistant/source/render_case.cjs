#!/usr/bin/env node
"use strict";

/**
 * Render a DE-IDENTIFIED EMR case into a clinician-readable card: problem list +
 * lab time-series (with deterministic ↑/↓) + imaging/history/specialty, closing
 * with the mandatory "this is a reference, not a diagnosis" footer.
 *
 * Defense-in-depth: this reader pulls ONLY known clinical fields by name. It never
 * dumps arbitrary/unknown fields, so even if a PHI value somehow slipped into the
 * object it would not be printed. Run it on de-identified cases regardless.
 *
 * Pure logic — no model, no network. Verified by scripts/test-clinical-case-render.mjs.
 */

const { annotateLabs } = require("./emr_schema.cjs");

const SAFETY_FOOTER =
  "以上为结构化辅助参考，非诊断结论。请执业医师核对原始病案后裁定。";

function arrow(flag) {
  if (flag === "low") return "↓";
  if (flag === "high") return "↑";
  if (flag === "unknown") return "?";
  return "";
}

function fmtDate(d) {
  return String(d || "").trim() || "—";
}

/** Group labs by (canonical) name, ordered by date, into a single trend line each. */
function labSeries(labs, sex) {
  const annotated = annotateLabs(labs, sex);
  const byName = new Map();
  for (const lab of annotated) {
    if (!byName.has(lab.name)) byName.set(lab.name, []);
    byName.get(lab.name).push(lab);
  }
  const lines = [];
  for (const [name, points] of byName) {
    points.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const ref = points[0].refLow != null ? `参考 ${points[0].refLow}–${points[0].refHigh}` : "无参考范围";
    const unit = points[0].unit || "";
    const trend = points
      .map((p) => `${fmtDate(p.date)} ${p.value}${arrow(p.flag)}`)
      .join(" → ");
    lines.push(`- **${name}**（${unit}，${ref}）：${trend}`);
  }
  return lines;
}

function renderCaseMarkdown(c) {
  const d = c.demographics || {};
  const enc = c.encounter || {};
  const h = c.history || {};
  const out = [];

  out.push(`# 病历卡（已脱敏）`);
  const ids = [c.caseId && `病例 ${c.caseId}`, c.patientKey && `患者 ${c.patientKey}`].filter(Boolean).join(" · ");
  if (ids) out.push(`> ${ids}`);

  out.push(`\n## 基本信息`);
  const stay = enc.lengthOfStayDays != null ? `住院${enc.lengthOfStayDays}天` : "";
  const span = enc.admittedAt || enc.dischargedAt ? `（${fmtDate(enc.admittedAt)} → ${fmtDate(enc.dischargedAt)}）` : "";
  out.push([`${d.age != null ? d.age + "岁" : ""} ${d.sex || ""}`.trim(), enc.department, stay + span].filter(Boolean).join(" · "));

  if ((c.problems || []).length) {
    out.push(`\n## 问题列表（诊断）`);
    c.problems.forEach((p, i) => {
      const tag = p.rank === "primary" ? " 【主要】" : "";
      out.push(`${i + 1}. ${p.name}${p.icd ? ` (${p.icd})` : ""}${tag}`);
    });
  }

  const series = labSeries(c.labs || [], d.sex);
  if (series.length) {
    out.push(`\n## 化验时间序列`);
    out.push(...series);
  }

  if ((c.imaging || []).length) {
    out.push(`\n## 影像`);
    for (const im of c.imaging) out.push(`- ${im.modality ? im.modality + "：" : ""}${im.finding}`);
  }

  if ((c.specialty?.findings || []).length) {
    out.push(`\n## 专科情况`);
    for (const f of c.specialty.findings) out.push(`- ${f}`);
  }

  const histLines = [];
  if ((h.past || []).length) histLines.push(`- 既往：${h.past.join("；")}`);
  if ((h.medications || []).length) histLines.push(`- 用药：${h.medications.join("；")}`);
  if ((h.allergies || []).length) histLines.push(`- 过敏：${h.allergies.join("；")}`);
  if (histLines.length) { out.push(`\n## 既往与用药`); out.push(...histLines); }

  out.push(`\n---\n${SAFETY_FOOTER}`);
  return out.join("\n");
}

module.exports = { renderCaseMarkdown, labSeries, SAFETY_FOOTER, arrow };
