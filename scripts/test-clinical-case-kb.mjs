#!/usr/bin/env node
// Clinical Case Assistant — knowledge base (the ingested case files ARE the KB).
// Pure index + hybrid search; plus a disk round-trip over a temp dir.
// WHY: the product value is "ingest many records → query/advise over the whole
// library". These tests pin: free-text (Chinese) search finds the right case,
// structured similarity finds similar patients, the two fuse, irrelevant queries
// return nothing (so advice can abstain), and the KB loads from disk.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "resources/workspace-apps/clinical-case-assistant/source");
const { tokenize, buildIndex, searchKb, kbStats, loadKb } = require(path.join(SRC, "knowledge_base.cjs"));

// --- Chinese-aware tokenizer ----------------------------------------------------
const toks = tokenize("干燥综合征 D70.x04");
assert.ok(toks.has("干燥") && toks.has("综合"), "CJK bigrams produced");
assert.ok(toks.has("d70.x04"), "ICD/latin token kept");

// --- KB of several (de-identified) cases ---------------------------------------
const cases = [
  { caseId: "A", demographics: { sex: "女", age: 74 }, problems: [{ name: "干燥综合征", icd: "M35.000" }, { name: "白细胞减少", icd: "D70.x04" }], labs: [{ name: "白细胞", value: 1.89 }, { name: "血小板", value: 71 }], narrative: { chiefComplaint: "口干、眼干1年" } },
  { caseId: "B", demographics: { sex: "女", age: 70 }, problems: [{ name: "类风湿关节炎", icd: "M06.900" }], labs: [{ name: "血红蛋白", value: 95 }], narrative: { chiefComplaint: "多关节肿痛" } },
  { caseId: "C", demographics: { sex: "男", age: 30 }, problems: [{ name: "阑尾炎", icd: "K35.800" }], labs: [], narrative: { chiefComplaint: "右下腹痛" } },
];
const index = buildIndex(cases);
assert.equal(index.docs.length, 3, "index has one doc per case");

// free-text "问病例": Chinese keyword search finds the dry-mouth case
const q1 = searchKb(index, { query: "口干 眼干" });
assert.equal(q1.hits[0].case.caseId, "A", "text query surfaces the Sjögren case");
assert.ok(q1.hits[0].reasons.some((r) => r.includes("关键词")), "keyword hit explained");

// structured "相似新病人": an old female with cytopenia + Sjögren matches A, not C
const q2 = searchKb(index, { queryCase: { demographics: { sex: "女", age: 73 }, problems: [{ icd: "M35.000" }], labs: [{ name: "白细胞", value: 2.0 }, { name: "血小板", value: 80 }] } });
assert.equal(q2.hits[0].case.caseId, "A", "structured similarity finds the matching patient");
assert.ok(q2.hits.every((h) => h.case.caseId !== "C"), "the unrelated appendicitis case is not returned");

// hybrid: text + structured combine
const q3 = searchKb(index, { query: "关节", queryCase: { problems: [{ icd: "M06.900" }] } });
assert.equal(q3.hits[0].case.caseId, "B", "hybrid query ranks the RA case top");

// irrelevant query → nothing relevant → advice can abstain
const q4 = searchKb(index, { query: "骨折 车祸 颅脑" });
assert.equal(q4.hasRelevant, false, "no relevant hit → hasRelevant false (KB lets advice abstain)");

// --- stats ----------------------------------------------------------------------
const stats = kbStats(cases);
assert.equal(stats.cases, 3, "stats count cases");
assert.ok(stats.distinctDiagnoses >= 4, "stats count distinct diagnoses");

// --- disk round-trip: the KB loads from cases/*.case.json -----------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-kb-"));
fs.writeFileSync(path.join(dir, "A.case.json"), JSON.stringify(cases[0]));
fs.writeFileSync(path.join(dir, "B.case.json"), JSON.stringify(cases[1]));
fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me"); // non-case file ignored
fs.writeFileSync(path.join(dir, "bad.case.json"), "{corrupt"); // corrupt skipped, no crash
const loaded = loadKb(dir);
assert.equal(loaded.docs.length, 2, "loadKb reads only valid *.case.json files");
assert.equal(searchKb(loaded, { query: "口干" }).hits[0].case.caseId, "A", "search works over the disk-loaded KB");
fs.rmSync(dir, { recursive: true, force: true });

console.log("clinical-case-kb: ok");
