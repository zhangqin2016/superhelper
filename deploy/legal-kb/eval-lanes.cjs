#!/usr/bin/env node
// Scores each retrieval lane against golden-questions.json, on the host that
// serves the corpus: node eval-lanes.cjs --pack <pack dir> [--v2 http://127.0.0.1:8790]
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const PACK = arg("--pack");
const V2 = arg("--v2", "http://127.0.0.1:8790");
const K = Number(arg("--k", 5));
const golden = JSON.parse(fs.readFileSync(arg("--golden", path.join(__dirname, "golden-questions.json")), "utf8")).questions;

const HAN = /[㐀-䶿一-鿿豈-﫿]/;
function tokenize(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const tokens = new Set(words.filter((w) => w.length > 1));
  for (const w of words) { if (!HAN.test(w) || w.length < 2) continue; for (let i = 0; i < w.length - 1; i += 1) tokens.add(w.slice(i, i + 2)); }
  return [...tokens].slice(0, 64);
}
const db = PACK ? new DatabaseSync(path.join(PACK, "legal.sqlite"), { readOnly: true }) : null;
function packFts(q, k) {
  const match = tokenize(q).map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
  const rows = db.prepare(`SELECT a.id, a.title, a.article, a.verified, a.category, bm25(articles_fts) AS score FROM articles_fts JOIN articles a ON a.id = articles_fts.article_id WHERE articles_fts MATCH ? ORDER BY score LIMIT ?`).all(match, Math.max(k * 4, 20));
  return rows.map((r) => ({ title: r.title, article: r.article, validity: r.verified, category: r.category }));
}
async function v2(q, mode, k) {
  const res = await fetch(`${V2}/api/v2/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, topK: k, mode }) });
  const body = await res.json();
  return (body.results || []).map((r) => ({ title: r.title, article: r.label || (r.snippet && r.snippet.label) || "", validity: r.validityStatus || (r.validity && r.validity.status) || "" }));
}
const lawOf = (title) => String(title || "").replace(/^中华人民共和国/, "").replace(/[（(].*?[)）]$/, "").trim();
const hit = (r, g) => lawOf(r.title) === g.law && g.articles.includes(String(r.article || "").trim());
(async () => {
  const lanes = { pack_fts: (q) => packFts(q, K), v2_lexical: (q) => v2(q, "lexical", K), v2_semantic: (q) => v2(q, "semantic", 10) };
  const report = {};
  for (const [lane, fn] of Object.entries(lanes)) {
    if (lane === "pack_fts" && !db) continue;
    let r5 = 0, mrr = 0, ms = 0; const misses = [];
    for (const g of golden) {
      const t0 = Date.now(); let rows = [];
      try { rows = await fn(g.q); } catch (e) { rows = []; }
      ms += Date.now() - t0;
      const rank = rows.findIndex((r) => hit(r, g));
      if (rank >= 0 && rank < K) r5 += 1; else misses.push(`${g.q} → ${rows.slice(0, 2).map((r) => `${lawOf(r.title)}${r.article}`).join(" / ") || "∅"}`);
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    report[lane] = { recallAtK: `${r5}/${golden.length}`, mrr: +(mrr / golden.length).toFixed(3), avgMs: Math.round(ms / golden.length), misses };
  }
  console.log(JSON.stringify(report, null, 1));
})();
