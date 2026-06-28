#!/usr/bin/env node
"use strict";

/**
 * CLI over the knowledge base (the ingested case files in `cases/`). Retrieval is
 * deterministic and needs NO model — it ranks relevant/similar cases so the
 * physician (or the agent) can pull up prior cases instantly.
 *
 * stdin JSON: { dir?, query?, queryCase?, limit? }
 *   - query     : free-text question (问病例) → keyword search
 *   - queryCase : a structured case (相似新病人) → structured similarity
 *   - both      : hybrid
 * Returns { ok, kbSize, hits:[{caseId,score,reasons,summary}], hasRelevant, stats }.
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadKb, kbStats } = require("./knowledge_base.cjs");
const { searchKb } = require("./knowledge_base.cjs");
const { caseSummary } = require("./advise.cjs");

function emit(payload, code = 0) {
  (code === 0 ? process.stdout : process.stderr).write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const dir = input.dir || path.join(process.cwd(), "cases");
  const index = loadKb(dir);
  const { hits, hasRelevant } = searchKb(index, { query: input.query, queryCase: input.queryCase, limit: Number(input.limit || 5) });
  emit({
    ok: true,
    kbSize: index.cases.length,
    hasRelevant,
    hits: hits.map((h) => ({ caseId: h.case.caseId || h.case.patientKey, score: Number(h.score.toFixed(2)), reasons: h.reasons, summary: caseSummary(h.case) })),
    stats: kbStats(index.cases),
  });
} catch (err) {
  emit({ ok: false, code: "KB_QUERY_FAILED", message: err.message }, 1);
}
