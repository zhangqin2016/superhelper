#!/usr/bin/env node
// Offline replay of skill routing against what models actually chose — the
// method OpenAI uses for Codex's cheap skill selectors (codex-rs/ext/skills
// shadow_selection_experiment): selectors run in shadow, never changing the
// prompt, and each time the model invokes a skill every selector is scored on
// whether it had ranked that skill (hit + rank bucket, split by query script).
//
// Ground truth here = the skill guides the model READ in a turn (read of
// .../skills/<id>/SKILL.md, a shell `cat` of one, or the native `skill` tool).
// Methods compared:
//   rules      — today's capability-broker (hand-written per-skill rules)
//   bm25       — fielded BM25 over each skill's own declared text
//   charngram  — character n-gram cosine over the same text
// The generic methods read only what a skill declares about itself (id, name,
// description zh/en, intents, match hints); no per-skill code.
//
// BIAS: the field reads were made WITH the rules' recommendations in context
// (the listing always; the "Best match" directive since 2026-09-27), so this
// replay favours `rules`. Results are split before/after the directive.
//
// Usage: node scripts/eval-skill-routing-replay.mjs <copy-of-opencode.db> [--json out.json]
//        node scripts/eval-skill-routing-replay.mjs --shadow-log <userData>/skill-routing-shadow.jsonl
// The second form summarises the ONLINE shadow log (src/main/skill-routing-shadow.js).
// Never point it at the live database; copy it first. Output stays local (it
// contains user requests).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const broker = require(path.join(ROOT, "src/main/capability-broker.js"));
const shadow = require(path.join(ROOT, "src/main/skill-routing-shadow.js"));
const layers = require(path.join(ROOT, "resources/opencode-plugins/lib/stale-turn-layers.cjs"));
const { DIRECTIVE_MIN_SCORE } = require(path.join(ROOT, "src/main/skill-guide-directive.js"));

if (process.argv[2] === "--shadow-log") {
  const events = fs.readFileSync(process.argv[3], "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const turns = events.filter((e) => e.kind === "turn");
  const inv = events.filter((e) => e.kind === "invocation");
  const readTurns = new Set(inv.map((e) => e.turn));
  const p = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
  console.log(`turns ${turns.length}; turns that read any skill guide ${readTurns.size} (${p(readTurns.size, turns.length)})`);
  for (const method of [...new Set(inv.map((e) => e.method))]) {
    const rows = inv.filter((e) => e.method === method && e.inCatalog);
    const hit1 = rows.filter((e) => e.rank === "1").length;
    const hit8 = rows.filter((e) => ["1", "2-3", "4-8"].includes(e.rank)).length;
    console.log(`  ${method.padEnd(6)} in-catalog reads ${rows.length}  hit@1 ${p(hit1, rows.length)}  hit@8 ${p(hit8, rows.length)}`);
  }
  const outsideReads = inv.filter((e) => !e.inCatalog && e.method === "rules").length;
  console.log(`  reads of skills outside the router's catalog: ${outsideReads}`);
  process.exit(0);
}
const dbPath = process.argv[2];
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : "";
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("Usage: node scripts/eval-skill-routing-replay.mjs <copy-of-opencode.db> [--json out.json]");
  process.exit(2);
}
const DIRECTIVE_SINCE = Date.parse("2026-09-26T20:45:42Z"); // 34404773

// ---- skill documents and BM25: shared with the online shadow selector ------
const documents = shadow.skillDocuments();
const eligible = new Set(documents.map((doc) => doc.id));
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const bm25Rank = (query) => shadow.lexicalRank(query, documents);
function charGrams(text) {
  const clean = String(text || "").toLowerCase().replace(/\s+/g, " ");
  const grams = new Map();
  const n = (i) => (CJK.test(clean[i]) ? 2 : 3);
  for (let i = 0; i < clean.length; i += 1) {
    const gram = clean.slice(i, i + n(i));
    if (gram.length < 2 || !gram.trim()) continue;
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return grams;
}

// ---- character n-gram cosine -----------------------------------------------
const gramDocs = documents.map((doc) => {
  const grams = charGrams(Object.values(doc.fields).join(" "));
  const norm = Math.sqrt([...grams.values()].reduce((sum, v) => sum + v * v, 0));
  return { id: doc.id, grams, norm };
});
function charRank(query) {
  const q = charGrams(query);
  const qNorm = Math.sqrt([...q.values()].reduce((sum, v) => sum + v * v, 0));
  if (!qNorm) return [];
  return gramDocs
    .map((doc) => {
      let dot = 0;
      for (const [gram, count] of q) dot += count * (doc.grams.get(gram) || 0);
      return { id: doc.id, score: dot / (qNorm * doc.norm || 1) };
    })
    .filter((item) => item.score > 0.02)
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id))
    .map((item) => item.id);
}

// ---- turns and ground truth from the engine database -----------------------
const REQUEST_RE = /<lily_layer title="user_original_request">\n([\s\S]*?)\n<\/lily_layer>/;
const PROVENANCE_RE = /Attachment provenance for THIS user message[^\n]*\n(\{[^\n]*\})/;
function requestOf(text) {
  const body = (text.match(REQUEST_RE) || [])[1] || "";
  return body.replace(/^Highest priority\.[^\n]*\n+/, "").trim();
}
function filesOf(text) {
  try {
    const manifest = JSON.parse((text.match(PROVENANCE_RE) || [])[1] || "{}");
    return (manifest.attachments || []).map((item) => ({ name: item.name || item.filename || "", path: item.path || item.name || "" }));
  } catch {
    return [];
  }
}
const skillReadOf = (part) => (part.type === "tool" ? shadow.skillIdFromTool({ name: part.tool, input: part.state?.input }) : "");

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(`select m.session_id s, m.id mid, m.time_created t, json_extract(m.data,'$.role') role, p.data pd
  from message m join part p on p.message_id = m.id order by m.session_id, m.time_created, m.id, p.id`).all();
const turns = [];
let current = null;
let session = null;
for (const row of rows) {
  let part;
  try { part = JSON.parse(row.pd); } catch { continue; }
  if (row.s !== session) { session = row.s; current = null; }
  if (row.role === "user" && part.type === "text" && layers.opensTurn(String(part.text || ""))) {
    const text = String(part.text || "");
    current = { session: row.s, at: row.t, request: requestOf(text), files: filesOf(text), reads: [] };
    if (current.request) turns.push(current);
    continue;
  }
  if (current && row.role === "assistant") {
    const id = skillReadOf(part);
    if (id && !current.reads.includes(id)) current.reads.push(id);
  }
}

// ---- scoring (Codex: per invocation, hit + rank bucket, by query script) ---
const METHODS = {
  rules: (turn) => broker.rankSkillCapabilityGraph({ text: turn.request, files: turn.files, maxSkills: 30 }).map((item) => item.skill.id),
  bm25: (turn) => bm25Rank(`${turn.request} ${turn.files.map((f) => f.name).join(" ")}`),
  charngram: (turn) => charRank(`${turn.request} ${turn.files.map((f) => f.name).join(" ")}`),
};
const bucket = shadow.rankBucket;
const blank = () => ({ invocations: 0, hit1: 0, hit3: 0, hit8: 0, rr: 0 });
const results = {};
const directive = {};
const outside = new Map();
const perTurn = [];
let turnsWithReads = 0;
for (const turn of turns) {
  const reads = turn.reads.filter((id) => eligible.has(id));
  for (const id of turn.reads.filter((x) => !eligible.has(x))) outside.set(id, (outside.get(id) || 0) + 1);
  const period = turn.at >= DIRECTIVE_SINCE ? "withDirective" : "beforeDirective";
  const script = CJK.test(turn.request) ? "cjk" : "latin";
  const ranked = Object.fromEntries(Object.entries(METHODS).map(([name, fn]) => [name, fn(turn)]));
  const top = broker.rankSkillCapabilityGraph({ text: turn.request, files: turn.files, maxSkills: 1 })[0];
  if (top && top.score >= DIRECTIVE_MIN_SCORE) {
    const d = (directive[period] ||= { fired: 0, firedRead: 0, firedOther: 0, firedNothing: 0 });
    d.fired += 1;
    if (turn.reads.includes(top.skill.id)) d.firedRead += 1;
    else if (turn.reads.length) d.firedOther += 1;
    else d.firedNothing += 1;
  }
  if (!reads.length) continue;
  turnsWithReads += 1;
  const row = { request: turn.request.slice(0, 160), reads, ranks: {} };
  for (const [name, list] of Object.entries(ranked)) {
    for (const id of reads) {
      const rank = list.indexOf(id) + 1 || 0;
      for (const key of ["all", period, script]) {
        results[name] ||= {};
        results[name][key] ||= blank();
        const r = results[name][key];
        r.invocations += 1;
        if (rank === 1) r.hit1 += 1;
        if (rank && rank <= 3) r.hit3 += 1;
        if (rank && rank <= 8) r.hit8 += 1;
        if (rank) r.rr += 1 / rank;
      }
      row.ranks[`${name}:${id}`] = bucket(rank);
    }
    row[`${name}Top3`] = list.slice(0, 3);
  }
  perTurn.push(row);
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
console.log(`turns: ${turns.length}; turns that read an eligible skill guide: ${turnsWithReads}; skills in the router: ${eligible.size}`);
for (const key of ["all", "beforeDirective", "withDirective", "cjk", "latin"]) {
  console.log(`\n[${key}]`);
  for (const name of Object.keys(METHODS)) {
    const r = results[name]?.[key];
    if (!r) continue;
    console.log(`  ${name.padEnd(10)} n=${String(r.invocations).padStart(4)}  hit@1 ${pct(r.hit1, r.invocations).padStart(6)}  hit@3 ${pct(r.hit3, r.invocations).padStart(6)}  hit@8 ${pct(r.hit8, r.invocations).padStart(6)}  MRR ${(r.rr / r.invocations).toFixed(3)}`);
  }
}
for (const [period, d] of Object.entries(directive)) console.log(`\n"Best match" directive (rules top score >= ${DIRECTIVE_MIN_SCORE}), ${period}: would fire on ${d.fired} turns — model read that guide ${d.firedRead} (${pct(d.firedRead, d.fired)}), read a different guide ${d.firedOther}, read none ${d.firedNothing}`);
if (outside.size) console.log(`reads outside the router's catalog: ${[...outside].map(([id, n]) => `${id}×${n}`).join(", ")}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ results, directive, perTurn }, null, 2));
