#!/usr/bin/env node
"use strict";

/**
 * Reasoning layer: "问病例" (Q&A grounded on one structured case) and "给相似新
 *病人参考建议" (decision support grounded on retrieved similar cases).
 *
 * The model only phrases; the SAFETY SHELL is deterministic and enforced here:
 *   1. red flags are computed by code and ALWAYS placed on top — even when advice
 *      abstains or the model returns nothing useful (Rule 13);
 *   2. every suggestion MUST carry an evidence reference; unreferenced claims are
 *      dropped (no ungrounded advice);
 *   3. if retrieval finds nothing similar enough → ABSTAIN ("信息不足，建议补充…")
 *      instead of grounding on noise;
 *   4. every output carries the "not a diagnosis, clinician decides" footer.
 *
 * `assembleAdvice` and the abstention logic are pure and unit-tested (the model is
 * injectable). The CLI wires a real model. Verified by
 * scripts/test-clinical-case-reasoning.mjs.
 */

const { detectRedFlags, renderRedFlags } = require("./red_flags.cjs");
const { retrieveSimilar } = require("./retrieve_cases.cjs");
const { searchKb } = require("./knowledge_base.cjs");

const NON_DIAGNOSIS_FOOTER =
  "⚕️ 以上为基于既往病例与规则的**辅助参考，非诊断结论**，不含具体用药剂量决策；请执业医师结合患者实际情况裁定。";

function caseSummary(c) {
  const d = c?.demographics || {};
  const probs = (c?.problems || []).map((p) => p.name + (p.icd ? `(${p.icd})` : "")).join("、");
  return `${c?.caseId || c?.patientKey || "病例"}：${d.age != null ? d.age + "岁" : ""}${d.sex || ""}，问题：${probs || "—"}`;
}

/** Keep only suggestions that cite evidence; tag the rest as dropped. Pure. */
function enforceEvidence(items) {
  const kept = [], dropped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const refs = Array.isArray(it?.evidenceRefs) ? it.evidenceRefs.filter(Boolean) : [];
    if (refs.length && it.point) kept.push({ point: String(it.point), evidenceRefs: refs, uncertainty: it.uncertainty ? String(it.uncertainty) : "" });
    else if (it?.point) dropped.push(String(it.point));
  }
  return { kept, dropped };
}

function renderSection(title, items) {
  if (!items.length) return "";
  const lines = items.map((it) => `- ${it.point} 【证据：${it.evidenceRefs.join("；")}】${it.uncertainty ? `（不确定性：${it.uncertainty}）` : ""}`);
  return [`## ${title}`, ...lines].join("\n");
}

/**
 * Assemble the final advice markdown. Pure.
 * @param {object} a { redFlags, retrieval:{hits,hasRelevant}, model:{differentials,workup,monitoring}|null, abstainReason? }
 */
function assembleAdvice(a) {
  const out = [];
  const flagBlock = renderRedFlags(a.redFlags || []);
  if (flagBlock) out.push(flagBlock); // red flags ALWAYS first, even when abstaining

  if (!a.retrieval || !a.retrieval.hasRelevant) {
    out.push("## 参考建议");
    out.push(`信息不足：病例库中没有与该患者足够相似的既往病例${a.abstainReason ? `（${a.abstainReason}）` : ""}。建议补充关键信息（如自身抗体谱、骨髓/影像结果）后再评估，或扩充病例库。`);
    out.push(`\n---\n${NON_DIAGNOSIS_FOOTER}`);
    return out.join("\n");
  }

  const m = a.model || {};
  const diff = enforceEvidence(m.differentials);
  const workup = enforceEvidence(m.workup);
  const monitor = enforceEvidence(m.monitoring);

  const sections = [
    renderSection(`参考方向（基于 ${a.retrieval.hits.length} 个相似病例）`, diff.kept),
    renderSection("建议完善的检查", workup.kept),
    renderSection("监测与随访", monitor.kept),
  ].filter(Boolean);
  if (sections.length) out.push(...sections);
  else out.push("## 参考建议\n模型未给出有充分证据支撑的建议；建议人工复核相似病例。");

  const dropped = [...diff.dropped, ...workup.dropped, ...monitor.dropped];
  if (dropped.length) out.push(`\n> 注：已隐去 ${dropped.length} 条无证据支撑的建议（不展示未grounded内容）。`);

  out.push(`\n## 相似病例（出处）`);
  for (const h of a.retrieval.hits) out.push(`- ${caseSummary(h.case)} 〔相似度 ${h.score.toFixed(1)}：${h.reasons.join("、")}〕`);

  out.push(`\n---\n${NON_DIAGNOSIS_FOOTER}`);
  return out.join("\n");
}

/** Build a decision-support package for a new patient. modelFn(prompt)->object|null injectable. */
async function buildAdvice(queryCase, library, modelFn, opts = {}) {
  const redFlags = detectRedFlags(queryCase);
  const retrieval = retrieveSimilar(queryCase, library, opts);
  if (!retrieval.hasRelevant) return { markdown: assembleAdvice({ redFlags, retrieval }), redFlags, retrieval, abstained: true };

  const prompt = buildAdvicePrompt(queryCase, retrieval.hits);
  let model = null;
  try { model = typeof modelFn === "function" ? await modelFn(prompt) : null; } catch { model = null; }
  return { markdown: assembleAdvice({ redFlags, retrieval, model }), redFlags, retrieval, abstained: false };
}

function buildAdvicePrompt(queryCase, hits) {
  return [
    "你是临床辅助参考助手（仅供执业医师参考，禁止下诊断、禁止给具体用药剂量）。",
    "根据【新患者】与【相似既往病例】，给出参考方向、建议完善的检查、监测随访。",
    '严格只输出 JSON：{ "differentials":[{"point":"","evidenceRefs":["病例X/化验Y/指南"],"uncertainty":""}], "workup":[...], "monitoring":[...] }',
    "每条建议必须在 evidenceRefs 注明依据（相似病例编号 / 具体化验 / 指南名）；没有依据的不要写。",
    `\n【新患者】\n${caseSummary(queryCase)}`,
    `\n【相似既往病例】\n${hits.map((h) => "- " + caseSummary(h.case) + ` 〔${h.reasons.join("、")}〕`).join("\n")}`,
  ].join("\n");
}

/**
 * 问病例: answer a free-text question grounded on the KB. Retrieves relevant
 * cases (hybrid search), then the model answers ONLY from them; abstains if the
 * KB has nothing relevant. modelFn(prompt)->string injectable. Returns
 * { markdown, hits, abstained }.
 */
async function answerQuestion(kbIndex, question, modelFn, opts = {}) {
  const { hits, hasRelevant } = searchKb(kbIndex, { query: question, limit: Number(opts.limit || 5) });
  if (!hasRelevant) {
    return { markdown: `知识库中没有与该问题相关的病例,无法作答。建议先导入相关病案,或换个问法。\n\n---\n${NON_DIAGNOSIS_FOOTER}`, hits: [], abstained: true };
  }
  const prompt = [
    "你是病例知识库问答助手(仅供执业医师参考,非诊断,不给具体用药剂量)。",
    "只依据下列【命中病例】回答问题,引用具体病例编号/化验/诊断作为出处;命中病例没有的信息,回答\"现有病例未记录\",不要编造。",
    `\n【问题】${question}`,
    `\n【命中病例】\n${hits.map((h) => "- " + caseSummary(h.case) + ` 〔${h.reasons.join("、")}〕`).join("\n")}`,
  ].join("\n");
  let answer = "";
  try { answer = typeof modelFn === "function" ? String(await modelFn(prompt) || "") : ""; } catch { answer = ""; }
  const provenance = ["\n## 依据病例(出处)", ...hits.map((h) => `- ${caseSummary(h.case)}`)].join("\n");
  const body = answer.trim() || "(未获得模型回答;以下为命中的相关病例,请人工查阅。)";
  return { markdown: `${body}\n${provenance}\n\n---\n${NON_DIAGNOSIS_FOOTER}`, hits, abstained: false };
}

module.exports = { assembleAdvice, enforceEvidence, buildAdvice, buildAdvicePrompt, answerQuestion, caseSummary, NON_DIAGNOSIS_FOOTER };
