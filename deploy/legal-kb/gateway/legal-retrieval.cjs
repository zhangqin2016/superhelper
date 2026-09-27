"use strict";

/**
 * Legal retrieval: find the governing law, then the article inside it.
 *
 * Measured on the production corpus (golden-questions.json, 25 plain-language
 * questions a client asks): the V2 service's lexical lane found the answering
 * article in the top 5 for 7, its semantic lane for 8 — a question in everyday
 * words ("员工严重违反规章制度公司能否解除合同") returned the patent examination
 * guide and the maritime code, or the purpose clause (第一条) of provincial
 * regulations. Ranking a law's own articles once the law is known found 24 of
 * 25 in 26 ms. So retrieval here follows a lawyer's order:
 *
 *   1. the governing law — named in the question, named by the caller (the
 *      agent model knows which law governs; that is judgment, and the corpus
 *      still decides what is cited), or voted by the service's lexical and
 *      semantic lanes, national law weighted above local regulation and
 *      repealed law excluded;
 *   2. the article — the law's current version (latest promulgation in the
 *      corpus, every 编 of a code) ranked by BM25 over its own articles; an
 *      explicit 第X条 is looked up exactly.
 *
 * Every article returned is the V27 pack's full text, never a model's words.
 * Nothing here is a model call.
 */

const path = require("node:path");
const fs = require("node:fs");

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const MAX_TEXT = 3000;
// Question words that say nothing about which article answers.
const STOP_GRAMS = new Set(["可以", "什么", "怎么", "需要", "能否", "能不", "不能", "多少", "情况", "条件", "应当", "是否", "如何", "哪些", "规定", "法律", "问题"]);
const CATEGORY_WEIGHT = Object.freeze({ "法律": 1, "行政法规": 0.85, "司法解释": 0.8, "监察法规": 0.8, "部门规章": 0.6, "司法文件": 0.55, "地方性法规": 0.45, "地方政府规章": 0.4 });
const CN_DIGITS = "零一二三四五六七八九";

function baseTitle(title) {
  return String(title || "").replace(/[《》\s]/g, "").replace(/^中华人民共和国/, "").replace(/[·•].*$/, "")
    .replace(/[（(][^)）]*[)）]$/, "").trim();
}

function grams(text) {
  const out = [];
  for (const word of String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (!HAN.test(word)) { if (word.length > 1) out.push(word); continue; }
    for (let i = 0; i < word.length - 1; i += 1) out.push(word.slice(i, i + 2));
  }
  return out;
}

function intToChinese(n) {
  if (n <= 10) return n === 10 ? "十" : CN_DIGITS[n];
  if (n < 20) return `十${n % 10 ? CN_DIGITS[n % 10] : ""}`;
  if (n < 100) return `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ""}`;
  if (n < 1000) {
    const rest = n % 100;
    const head = `${CN_DIGITS[Math.floor(n / 100)]}百`;
    if (!rest) return head;
    return rest < 10 ? `${head}零${CN_DIGITS[rest]}` : `${head}${rest < 20 ? "一" : ""}${intToChinese(rest)}`;
  }
  if (n < 10000) {
    const rest = n % 1000;
    const head = `${CN_DIGITS[Math.floor(n / 1000)]}千`;
    if (!rest) return head;
    if (rest >= 100) return `${head}${intToChinese(rest)}`;
    return `${head}零${rest < 10 ? CN_DIGITS[rest] : `${rest < 20 ? "一" : ""}${intToChinese(rest)}`}`;
  }
  return String(n);
}

/** "第39条" / "第三十九条" / "第三十九条之一" → the corpus's spelling, or "". */
function articleLabel(text) {
  const match = /第\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*条(之[一二三四五六七八九十]+)?/.exec(String(text || ""));
  if (!match) return "";
  const number = /^\d+$/.test(match[1]) ? intToChinese(Number(match[1])) : match[1].replace(/两/g, "二").replace(/〇/g, "零");
  return `第${number}条${match[2] || ""}`;
}

// Rows that describe a document rather than state a rule.
const NON_ARTICLES = new Set(["题注"]);

class LegalCorpus {
  constructor({ packDir, openDatabase, aliases = null }) {
    // The corpus author's registered abbreviations (民诉法 → 民事诉讼法) and
    // intent words — one source, read from the V2 service when it is present.
    this.lawAliases = aliases?.LAW_ALIASES || {};
    this.intentStopwords = aliases?.INTENT_STOPWORDS || new Set();
    this.packDir = packDir;
    this.manifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));
    const catalog = JSON.parse(fs.readFileSync(path.join(packDir, "catalog.json"), "utf8"));
    // base title -> every document carrying it; the current one per exact title.
    this.laws = new Map();
    for (const doc of Array.isArray(catalog) ? catalog : []) {
      const key = baseTitle(doc.title);
      if (!key) continue;
      if (!this.laws.has(key)) this.laws.set(key, []);
      this.laws.get(key).push(doc);
    }
    // Longest first, so "劳动合同法实施条例" is recognised before "劳动合同法".
    this.lawNames = [...this.laws.keys()].filter((name) => name.length >= 3).sort((a, b) => b.length - a.length);
    this.db = openDatabase(path.join(packDir, "legal.sqlite"));
    this.rangeStatement = this.db.prepare("SELECT id, title, article, text, category, authority, promulgated_at, effective_at, verified FROM articles WHERE id >= ? AND id < ?");
    this.idStatement = this.db.prepare("SELECT id, title, article, text, category, authority, promulgated_at, effective_at, verified FROM articles WHERE id = ?");
  }

  get version() { return String(this.manifest.contentVersion || ""); }

  canonical(name) {
    const base = baseTitle(name);
    return this.lawAliases[base] || base;
  }

  hasLaw(name) { return this.laws.has(this.canonical(name)); }

  /** The current version of a law: per exact title the latest promulgation (a code's 编 are separate titles). */
  currentDocuments(name) {
    const byTitle = new Map();
    for (const doc of this.laws.get(this.canonical(name)) || []) {
      const current = byTitle.get(doc.title);
      const newer = `${doc.promulgatedAt || ""}${doc.effectiveAt || ""}` > `${current?.promulgatedAt || ""}${current?.effectiveAt || ""}`;
      if (!current || newer) byTitle.set(doc.title, doc);
    }
    return [...byTitle.values()];
  }

  category(name) {
    return this.currentDocuments(name)[0]?.category || "";
  }

  articlesOf(name) {
    return this.currentDocuments(name).flatMap((doc) => {
      const prefix = `${doc.sourcePath}#`;
      return this.rangeStatement.all(prefix, `${prefix}\uffff`).filter((row) => !NON_ARTICLES.has(row.article));
    });
  }

  article(id) { return this.idStatement.get(String(id || "")) || null; }

  /** Laws named in the question itself, longest first and non-overlapping. */
  lawsNamedIn(text) {
    let rest = String(text || "").replace(/[《》]/g, "");
    const found = [];
    for (const [alias, name] of Object.entries(this.lawAliases)) {
      if (rest.includes(alias) && this.laws.has(name)) { found.push(name); rest = rest.split(alias).join(" "); }
    }
    for (const name of this.lawNames) {
      if (!rest.includes(name)) continue;
      found.push(name);
      rest = rest.split(name).join(" ");
      if (found.length >= 3) break;
    }
    return found;
  }
}

/** BM25 over one law's own articles: document frequencies are that law's. */
function rankWithin(query, articles, stopwords = new Set()) {
  let text = String(query || "");
  for (const word of stopwords) text = text.split(word).join(" ");
  const terms = [...new Set(grams(text))].filter((term) => !STOP_GRAMS.has(term));
  if (!terms.length || !articles.length) return [];
  const df = new Map();
  const docs = articles.map((row) => {
    const tokens = grams(`${row.article} ${row.text}`);
    for (const term of new Set(tokens)) df.set(term, (df.get(term) || 0) + 1);
    return { row, tokens };
  });
  const n = docs.length;
  const avg = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / n || 1;
  return docs.map(({ row, tokens }) => {
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) || 0;
      if (!f) continue;
      const d = df.get(term) || 0;
      score += Math.log(1 + (n - d + 0.5) / (d + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * tokens.length / avg));
    }
    return { row, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
}

function shapeArticle(row, extra = {}) {
  const text = String(row.text || "");
  return {
    id: row.id,
    law: baseTitle(row.title),
    title: row.title,
    article: row.article,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    textTruncated: text.length > MAX_TEXT,
    category: row.category || "",
    authority: row.authority || "",
    promulgatedAt: row.promulgated_at || "",
    effectiveAt: row.effective_at || "",
    sourceVerified: row.verified || "",
    ...extra,
  };
}

/**
 * @param {LegalCorpus} corpus
 * @param {{query: string, laws?: string[], topK?: number, includeHistorical?: boolean}} input
 * @param {{v2Search?: Function, lawValidity?: Function, log?: Function}} deps
 */
async function searchLegal(corpus, input, deps = {}) {
  const query = String(input.query || "").replace(/\s+/g, " ").trim();
  const topK = Math.max(1, Math.min(20, Number(input.topK) || 8));
  const log = deps.log || (() => {});
  const provided = (Array.isArray(input.laws) ? input.laws : []).map((name) => corpus.canonical(name)).filter(Boolean).slice(0, 5);
  const unresolvedLaws = provided.filter((name) => !corpus.hasLaw(name));
  const named = corpus.lawsNamedIn(query);
  const label = articleLabel(query);

  // Lane votes for the governing law. When the question or the caller named
  // one, the votes still run — a caller can name the wrong law — but rank below.
  const weights = new Map();
  const add = (name, weight, source) => {
    if (!corpus.hasLaw(name)) return;
    const prev = weights.get(name);
    if (!prev || prev.weight < weight) weights.set(name, { weight, source });
  };
  for (const name of named) add(name, 1, "named");
  for (const name of provided) add(name, 1, "caller");
  let lanes = [];
  const namedAlready = weights.size > 0;
  if (typeof deps.v2Search === "function") {
    const settled = await Promise.allSettled(["semantic", "lexical"].map((mode) => deps.v2Search(query, mode)));
    settled.forEach((outcome, i) => {
      if (outcome.status === "rejected") log(`lane ${i ? "lexical" : "semantic"} failed: ${outcome.reason?.message || outcome.reason}`);
    });
    lanes = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
    const votes = new Map();
    const perLane = settled.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
    for (const results of perLane) {
      results.forEach((item, rank) => {
        if (/expired|repealed|失效|废止/.test(String(item.validity || ""))) return;
        const name = baseTitle(item.title);
        if (!corpus.hasLaw(name)) return;
        const weight = CATEGORY_WEIGHT[corpus.category(name)] ?? 0.4;
        votes.set(name, (votes.get(name) || 0) + weight / (rank + 3));
      });
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const top = ranked[0]?.[1] || 1;
    for (const [name, vote] of ranked) add(name, (namedAlready ? 0.3 : 0.5) + (namedAlready ? 0.3 : 0.4) * (vote / top), "voted");
  }

  const results = [];
  const seen = new Set();
  for (const [name, { weight, source }] of weights) {
    const articles = corpus.articlesOf(name);
    if (label) {
      const exact = articles.find((row) => row.article === label);
      if (exact && !seen.has(exact.id)) {
        seen.add(exact.id);
        results.push({ score: 10 + weight, item: shapeArticle(exact, { lane: "exact", lawSource: source }) });
      }
    }
    const ranked = rankWithin(query, articles, corpus.intentStopwords).slice(0, topK);
    const best = ranked[0]?.score || 1;
    for (const { row, score } of ranked) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      results.push({ score: weight * (score / best), item: shapeArticle(row, { lane: "within_law", lawSource: source }) });
    }
  }
  results.sort((a, b) => b.score - a.score);

  // The law's validity as the service knows it; a repealed law is kept only on request.
  const out = [];
  for (const { item, score } of results) {
    let validity = "unknown";
    if (typeof deps.lawValidity === "function") {
      try { validity = (await deps.lawValidity(item.title)) || "unknown"; } catch (error) { log(`validity lookup failed for ${item.title}: ${error?.message || error}`); }
    }
    if (!input.includeHistorical && /expired|repealed/.test(validity)) continue;
    out.push({ ...item, validity, score: Number(score.toFixed(4)) });
    if (out.length >= topK) break;
  }
  return {
    ok: true,
    corpusVersion: corpus.version,
    laws: [...weights.entries()].map(([name, { weight, source }]) => ({ name, source, weight: Number(weight.toFixed(3)) })),
    ...(unresolvedLaws.length ? { unresolvedLaws } : {}),
    ...(label ? { articleLabel: label } : {}),
    results: out,
    ...(!out.length && lanes.length ? { note: "no governing law could be identified; name the law in `laws`" } : {}),
  };
}

function getArticle(corpus, { id, law, article } = {}) {
  let row = id ? corpus.article(id) : null;
  if (!row && law && article) {
    const label = articleLabel(article) || String(article);
    row = corpus.articlesOf(law).find((item) => item.article === label) || null;
  }
  if (!row) return { ok: false, error: "LEGAL_ARTICLE_NOT_FOUND" };
  const text = String(row.text || "");
  return { ok: true, corpusVersion: corpus.version, article: { ...shapeArticle(row), text, textTruncated: false } };
}

module.exports = { LegalCorpus, articleLabel, baseTitle, getArticle, grams, intToChinese, rankWithin, searchLegal };
