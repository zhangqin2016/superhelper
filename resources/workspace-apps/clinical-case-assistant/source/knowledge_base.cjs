#!/usr/bin/env node
"use strict";

/**
 * Knowledge base over the ingested case files. THE CASE FILES *ARE* THE KB:
 * every de-identified case JSON in the app's `cases/` dir is one KB document.
 * The KB lives inside the installed app's workspace (data isolation), grows as
 * the clinician ingests more records, and powers both "问病例" and "给相似新病人
 * 参考建议".
 *
 * Hybrid retrieval, deterministic by default (Rule 13 — degrades without a model):
 *   - keyword/text search over the de-identified clinical text (Chinese-aware:
 *     CJK bigrams + latin/icd tokens), for free-form "问病例" questions;
 *   - structured clinical similarity (problems / labs / demographics) via
 *     retrieve_cases.scorePair, for "find similar patients".
 * An embedding model can later be plugged in as an additional ranker; absent one,
 * keyword+structured already works offline.
 *
 * Index build + search are PURE; only loadCases/saveCase touch disk. Verified by
 * scripts/test-clinical-case-kb.mjs.
 */

const fs = require("node:fs");
const path = require("node:path");
const { scorePair } = require("./retrieve_cases.cjs");

/** Chinese-aware tokenizer: CJK bigrams (no word boundaries in Chinese) + latin/
 *  numeric/ICD tokens. Deterministic, no model. */
function tokenize(text) {
  const s = String(text || "");
  const tokens = new Set();
  for (const m of s.toLowerCase().match(/[a-z0-9][a-z0-9.]*/g) || []) if (m.length >= 2) tokens.add(m);
  for (const run of s.match(/[一-鿿]+/g) || []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** The searchable clinical text of a (de-identified) case — never PHI. */
function caseText(c) {
  return [
    (c?.problems || []).map((p) => `${p.name || ""} ${p.icd || ""}`).join(" "),
    (c?.specialty?.findings || []).join(" "),
    c?.narrative?.chiefComplaint || "",
    c?.narrative?.presentIllness || "",
    (c?.labs || []).map((l) => l.name).join(" "),
    (c?.imaging || []).map((im) => im.finding || "").join(" "),
  ].join(" ");
}

function buildIndex(cases) {
  const list = Array.isArray(cases) ? cases.filter((c) => c && typeof c === "object") : [];
  return { cases: list, docs: list.map((c) => ({ case: c, tokens: tokenize(caseText(c)) })) };
}

function keywordOverlap(queryTokens, docTokens) {
  let n = 0;
  for (const t of queryTokens) if (docTokens.has(t)) n += 1;
  return n;
}

/**
 * Hybrid search over the KB index.
 * opts: { query?:string(free text), queryCase?:object(structured), limit?, minScore? }
 * Returns { hits:[{case,score,reasons}], hasRelevant }.
 */
function searchKb(index, opts = {}) {
  const limit = Number(opts.limit || 5);
  const minScore = opts.minScore != null ? Number(opts.minScore) : 1;
  const qTokens = opts.query ? tokenize(opts.query) : new Set();
  const scored = (index?.docs || []).map(({ case: c, tokens }) => {
    let score = 0;
    const reasons = [];
    const kw = keywordOverlap(qTokens, tokens);
    if (kw) { score += kw * 0.5; reasons.push(`关键词命中×${kw}`); }
    if (opts.queryCase) {
      const s = scorePair(opts.queryCase, c);
      if (s.score > 0) { score += s.score; reasons.push(...s.reasons); }
    }
    return { case: c, score, reasons };
  }).filter((h) => h.score > 0).sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, limit);
  return { hits, hasRelevant: hits.length > 0 && hits[0].score >= minScore };
}

function kbStats(cases) {
  const list = Array.isArray(cases) ? cases : [];
  const dx = new Map();
  let labPoints = 0;
  for (const c of list) {
    for (const p of c?.problems || []) { const k = p.icd || p.name; if (k) dx.set(k, (dx.get(k) || 0) + 1); }
    labPoints += (c?.labs || []).length;
  }
  const topDx = [...dx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ dx: k, count: n }));
  return { cases: list.length, labPoints, distinctDiagnoses: dx.size, topDiagnoses: topDx };
}

// ----- disk I/O (the only impure part) -----------------------------------------

/** Load every *.case.json in the KB dir. These are already de-identified. */
function loadCases(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".case.json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))); } catch { /* skip corrupt */ }
  }
  return out;
}

function loadKb(dir) {
  return buildIndex(loadCases(dir));
}

module.exports = { tokenize, caseText, buildIndex, searchKb, kbStats, loadCases, loadKb, keywordOverlap };
