#!/usr/bin/env node
"use strict";

/**
 * Clinical-similarity retrieval over the (de-identified) case library. Ranks past
 * cases against a query case by, in order of weight:
 *   - shared problems (ICD code match strongest, then diagnosis-name match),
 *   - shared abnormal lab pattern (same lab flagged the same direction),
 *   - demographics proximity (same sex, close age).
 *
 * Deliberately simple + explainable (each hit carries its `reasons`) — grounding
 * is the model's job; retrieval just surfaces candidates. Crucially it ALSO tells
 * the caller when nothing is similar enough, so advice can abstain ("信息不足")
 * instead of grounding on noise (Rule 13).
 *
 * Pure logic. Verified by scripts/test-clinical-case-reasoning.mjs.
 */

const { annotateLabs } = require("./emr_schema.cjs");

const W = { icd: 3, diagnosis: 2, labPattern: 1.5, sex: 0.5, age: 1 };
const MIN_RELEVANT_SCORE = 2; // below this, treat the library as having no real match

function problemKeys(c) {
  const icd = new Set(), name = new Set();
  for (const p of c?.problems || []) {
    if (p.icd) icd.add(String(p.icd).toLowerCase());
    if (p.name) name.add(String(p.name).toLowerCase());
  }
  return { icd, name };
}

// Set of "lab|direction" for abnormal labs (e.g. "白细胞|low").
function abnormalPattern(c) {
  const set = new Set();
  for (const lab of annotateLabs(c?.labs || [], c?.demographics?.sex)) {
    if (lab.flag === "low" || lab.flag === "high") set.add(`${lab.name}|${lab.flag}`);
  }
  return set;
}

function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function scorePair(query, candidate) {
  const reasons = [];
  let score = 0;

  const qp = problemKeys(query), cp = problemKeys(candidate);
  const icdHits = overlap(qp.icd, cp.icd);
  if (icdHits) { score += W.icd * icdHits; reasons.push(`共享诊断编码 ×${icdHits}`); }
  const nameHits = overlap(qp.name, cp.name);
  if (nameHits) { score += W.diagnosis * nameHits; reasons.push(`共享诊断名 ×${nameHits}`); }

  const labHits = overlap(abnormalPattern(query), abnormalPattern(candidate));
  if (labHits) { score += W.labPattern * labHits; reasons.push(`相同异常化验模式 ×${labHits}`); }

  const qs = query?.demographics?.sex, cs = candidate?.demographics?.sex;
  if (qs && cs && qs === cs) { score += W.sex; reasons.push("同性别"); }
  const qa = Number(query?.demographics?.age), ca = Number(candidate?.demographics?.age);
  if (Number.isFinite(qa) && Number.isFinite(ca) && Math.abs(qa - ca) <= 10) { score += W.age; reasons.push(`年龄相近(±${Math.abs(qa - ca)})`); }

  return { score, reasons };
}

/** Returns { hits:[{ case, score, reasons }], hasRelevant }. hasRelevant=false →
 *  caller should abstain rather than ground on weak matches. */
function retrieveSimilar(query, library, opts = {}) {
  const limit = Number(opts.limit || 5);
  const minScore = opts.minScore != null ? Number(opts.minScore) : MIN_RELEVANT_SCORE;
  const scored = (Array.isArray(library) ? library : [])
    .filter((c) => c && c.caseId !== query?.caseId)
    .map((c) => ({ case: c, ...scorePair(query, c) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, limit);
  return { hits, hasRelevant: hits.length > 0 && hits[0].score >= minScore };
}

module.exports = { retrieveSimilar, scorePair, abnormalPattern, MIN_RELEVANT_SCORE };
