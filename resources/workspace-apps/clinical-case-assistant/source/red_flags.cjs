#!/usr/bin/env node
"use strict";

/**
 * Deterministic red-flag detection over a (de-identified) case. These are CRITICAL
 * VALUES a clinician must not miss — so they are computed by code from thresholds,
 * never left to the model (Rule 5), and they are forced to the TOP of any advice
 * output (Rule 13: degrade safely — if the model says nothing useful, the red
 * flags still surface).
 *
 * Thresholds are conventional, configurable clinical config — NOT medical advice.
 * Each flag states the value + threshold + a CAUTION (monitor / evaluate), never a
 * treatment order. Sorted critical → high → moderate.
 *
 * Pure logic. Verified by scripts/test-clinical-case-reasoning.mjs.
 */

const { annotateLabs } = require("./emr_schema.cjs");

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2 };

// name → ordered rules; first matching (lowest value bound) wins per lab.
const LAB_RULES = {
  "中性粒细胞": [
    { max: 0.5, severity: "critical", label: "粒细胞缺乏", caution: "严重感染高危，建议尽快评估感染风险与血液科意见" },
    { max: 1.0, severity: "high", label: "重度中性粒细胞减少", caution: "感染风险升高，建议密切监测体温/感染征象" },
  ],
  "血小板": [
    { max: 20, severity: "critical", label: "重度血小板减少", caution: "自发出血高危，建议评估出血风险并尽快复查" },
    { max: 50, severity: "high", label: "显著血小板减少", caution: "出血风险升高，建议关注出血征象、避免创伤性操作" },
  ],
  "白细胞": [
    { max: 2.0, severity: "high", label: "重度白细胞减少", caution: "建议复查并评估骨髓/免疫相关病因" },
  ],
  "血红蛋白": [
    { max: 60, severity: "critical", label: "重度贫血", caution: "建议评估输血指征与失血来源" },
    { max: 90, severity: "high", label: "中度贫血", caution: "建议查找贫血病因并监测" },
  ],
  "钾": [
    { max: 2.5, severity: "critical", label: "严重低钾血症", caution: "心律失常高危，建议监测心电并评估补钾" },
    { max: 3.0, severity: "high", label: "低钾血症", caution: "建议复查血钾并评估病因" },
  ],
};

// Latest value per lab (by date) — red flags reflect the most recent state.
function latestByName(labs, sex) {
  const annotated = annotateLabs(labs, sex);
  const latest = new Map();
  for (const lab of annotated) {
    const prev = latest.get(lab.name);
    if (!prev || String(lab.date || "") >= String(prev.date || "")) latest.set(lab.name, lab);
  }
  return latest;
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Returns prioritized red flags: [{ severity, label, basis, caution }]. */
function detectRedFlags(c) {
  const flags = [];
  const sex = c?.demographics?.sex;
  const latest = latestByName(c?.labs || [], sex);

  for (const [name, rules] of Object.entries(LAB_RULES)) {
    const lab = latest.get(name);
    if (!lab) continue;
    const value = num(lab.value);
    if (value == null) continue;
    const hit = rules.find((r) => value < r.max); // rules ordered most-severe first
    if (hit) flags.push({ severity: hit.severity, label: hit.label, basis: `${name} ${lab.value} ${lab.unit || ""}`.trim() + `（${lab.date || "最近"}，<${hit.max}）`, caution: hit.caution });
  }

  // Blood pressure crisis from latest vitals.
  const sys = num(c?.vitals?.bpSys);
  const dia = num(c?.vitals?.bpDia);
  if ((sys != null && sys >= 180) || (dia != null && dia >= 110)) {
    flags.push({ severity: "high", label: "血压显著升高", basis: `血压 ${sys ?? "?"}/${dia ?? "?"}mmHg（≥180/110）`, caution: "建议复测并评估高血压急症/靶器官损害" });
  }

  // Problem-list keywords that warrant attention even without a numeric value.
  const PROBLEM_FLAGS = [{ re: /呼吸衰竭/, label: "呼吸衰竭" }, { re: /危象|危重/, label: "危重状态" }, { re: /出血/, label: "出血" }];
  for (const p of c?.problems || []) {
    for (const pf of PROBLEM_FLAGS) {
      if (pf.re.test(String(p.name || ""))) flags.push({ severity: "high", label: pf.label, basis: `诊断：${p.name}${p.icd ? ` (${p.icd})` : ""}`, caution: "建议结合临床评估其活动性与处置" });
    }
  }

  return flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function renderRedFlags(flags) {
  if (!flags.length) return "";
  const icon = { critical: "🚩🚩", high: "🚩", moderate: "⚠️" };
  return ["## 🚩 危急值/红旗（请优先关注）", ...flags.map((f) => `- ${icon[f.severity] || "⚠️"} **${f.label}**：${f.basis}。${f.caution}`)].join("\n");
}

module.exports = { detectRedFlags, renderRedFlags, LAB_RULES };
