#!/usr/bin/env node
// The retrieval gate: golden-questions.json against the running gateway.
//   node eval-gateway.cjs [--url http://127.0.0.1:8791] [--min-recall 0.9]
// Exits 1 when recall@5 in either scenario falls below --min-recall.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const arg = (n, f) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : f; };
const URL_ = arg("--url", "http://127.0.0.1:8791");
const MIN = Number(arg("--min-recall", 0.9));
const golden = JSON.parse(fs.readFileSync(arg("--golden", path.join(__dirname, "golden-questions.json")), "utf8")).questions;
const hit = (r, g) => r.law === g.law && g.articles.includes(r.article);
(async () => {
  const report = {};
  let failed = false;
  for (const scenario of ["no_law_hint", "law_named_by_agent"]) {
    let r5 = 0, mrr = 0, ms = 0, worst = 0; const misses = [];
    for (const g of golden) {
      const t0 = Date.now();
      const res = await fetch(`${URL_}/search`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: g.q, topK: 5, ...(scenario === "law_named_by_agent" ? { laws: [g.law] } : {}) }) });
      const body = await res.json();
      const took = Date.now() - t0; ms += took; worst = Math.max(worst, took);
      const rank = (body.results || []).findIndex((r) => hit(r, g));
      if (rank >= 0) { r5 += 1; mrr += 1 / (rank + 1); }
      else misses.push(`${g.q} → ${(body.results || []).slice(0, 3).map((r) => `${r.law}${r.article}`).join(" / ") || "∅"} [laws: ${(body.laws || []).map((l) => l.name).join(",")}]`);
    }
    const recall = r5 / golden.length;
    if (recall < MIN) failed = true;
    report[scenario] = { recallAt5: `${r5}/${golden.length}`, mrr: +(mrr / golden.length).toFixed(3), avgMs: Math.round(ms / golden.length), maxMs: worst, misses };
  }
  console.log(JSON.stringify(report, null, 1));
  process.exit(failed ? 1 : 0);
})();
