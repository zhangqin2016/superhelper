"use strict";

/**
 * Skill routing in SHADOW mode — the method OpenAI uses for Codex's cheap skill
 * selectors (codex-rs/ext/skills: `shadow_selection_enabled`, "selects likely-
 * relevant skills without changing the model-visible catalog"; each skill the
 * model then invokes is scored per selector: hit + rank, by query script).
 *
 * Which skill a turn needs is the MODEL's call, from the catalog in the guide
 * (name + when-to-use + guide path, "read the matching guide before acting").
 * Lily's hand-written router (capability-broker: per-skill id rules) used to
 * add its picks to every turn and, at >=120, a "Best match — read it first"
 * directive. Replayed on the field engine DB (2026-09-29,
 * scripts/eval-skill-routing-replay.mjs): hit@1 17%, 64% of the guides models
 * actually read were outside its top 8, a generic BM25 with no per-skill code
 * scored the same, and on turns where the model did read a guide the
 * directive's pick disagreed 67 of 107 times. So the router keeps running —
 * here, measured against what models actually read — but no longer writes into
 * the prompt. LILY_SKILL_ROUTING_SHADOW=0 restores the injected listing and
 * directive.
 *
 * The log holds no user text: a per-turn key, the selector, hit, rank bucket,
 * the query script and the skill id. Everything fails open.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LOG_FILE = "skill-routing-shadow.jsonl";
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const RANK_LIMIT = 30;
const CJK_RE = /[㐀-鿿豈-﫿]/;
const GUIDE_RE = /skills(?:-catalog)?\/([A-Za-z0-9._-]+)\/SKILL\.md/;

function isShadow() {
  return process.env.LILY_SKILL_ROUTING_SHADOW !== "0";
}

// ---- what each skill declares about itself (no per-skill code) -------------
let documentsCache = null;
function frontmatterDescription(guidePath) {
  try {
    const head = fs.readFileSync(guidePath, "utf8").slice(0, 4000);
    const block = (head.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
    const line = block.split("\n").find((l) => /^description:/.test(l)) || "";
    return line.replace(/^description:\s*/, "").replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}
function skillDocuments() {
  if (documentsCache) return documentsCache;
  const { listSkillCapabilityGraph } = require("./capability-broker");
  let registry = [];
  try {
    const { loadBundledRegistry } = require("./skill-registry");
    const loaded = loadBundledRegistry();
    registry = Array.isArray(loaded?.skills) ? loaded.skills : Array.isArray(loaded) ? loaded : [];
  } catch { /* declared text below still works without the registry */ }
  const byId = new Map(registry.map((entry) => [entry.id, entry]));
  documentsCache = listSkillCapabilityGraph({}).map((skill) => {
    const reg = byId.get(skill.id) || {};
    return {
      id: skill.id,
      fields: {
        name: [skill.id.replace(/[-_]/g, " "), reg.name || "", reg.name_i18n?.en || ""].join(" "),
        description: [reg.description || "", reg.description_i18n?.en || "", frontmatterDescription(skill.guidePath)].join(" "),
        intents: [...(skill.intents || []), ...(skill.matchHints || []).map(String)].join(" ").replace(/[._-]/g, " "),
      },
    };
  });
  return documentsCache;
}

// ---- fielded BM25 (latin words + CJK character bigrams) --------------------
function tokens(text) {
  const out = [];
  const lower = String(text || "").toLowerCase();
  for (const word of lower.match(/[a-z0-9]+/g) || []) if (word.length > 1) out.push(word);
  for (const run of lower.match(/[㐀-鿿豈-﫿]+/g) || []) {
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
    if (run.length === 1) out.push(run);
  }
  return out;
}
const FIELD_WEIGHTS = { name: 3, intents: 2, description: 1 };
let bm25Cache = null;
function bm25Index(documents) {
  if (bm25Cache?.documents === documents) return bm25Cache;
  const docs = documents.map((doc) => {
    const tf = new Map();
    let length = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      for (const token of tokens(doc.fields[field])) {
        tf.set(token, (tf.get(token) || 0) + weight);
        length += weight;
      }
    }
    return { id: doc.id, tf, length };
  });
  const df = new Map();
  for (const doc of docs) for (const token of doc.tf.keys()) df.set(token, (df.get(token) || 0) + 1);
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  bm25Cache = { documents, docs, df, avgLength };
  return bm25Cache;
}
function lexicalRank(query, documents = skillDocuments()) {
  const { docs, df, avgLength } = bm25Index(documents);
  const terms = [...new Set(tokens(query))];
  return docs
    .map((doc) => {
      let score = 0;
      for (const term of terms) {
        const f = doc.tf.get(term) || 0;
        if (!f) continue;
        const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
        score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (doc.length / avgLength))));
      }
      return { id: doc.id, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

// ---- which skill guide a tool call opened ----------------------------------
function skillIdFromTool(tool = {}) {
  const name = String(tool.name || tool.tool || "").toLowerCase();
  const input = tool.input && typeof tool.input === "object" ? tool.input : {};
  if (name === "skill") return String(input.name || "");
  if (name === "read") return (String(input.filePath || input.file_path || input.path || "").match(GUIDE_RE) || [])[1] || "";
  if (name === "bash") return (String(input.command || "").match(GUIDE_RE) || [])[1] || "";
  return "";
}

function rankBucket(rank) {
  if (rank === 1) return "1";
  if (rank && rank <= 3) return "2-3";
  if (rank && rank <= 8) return "4-8";
  return rank ? "9+" : "miss";
}

// ---- the local metric log ---------------------------------------------------
function logPath() {
  try {
    return require("./config").userDataPath(LOG_FILE);
  } catch {
    return "";
  }
}
function appendEvent(event) {
  const file = logPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch { /* metrics never affect a turn */ }
}

/**
 * Rank the catalog for this turn's request with every selector and remember the
 * rankings on the turn state. Nothing reaches the prompt.
 */
function beginTurn(state, { text = "", files = [] } = {}) {
  try {
    if (!state || typeof state !== "object") return null;
    const { rankSkillCapabilityGraph } = require("./capability-broker");
    const query = `${text} ${(Array.isArray(files) ? files : []).map((f) => f?.name || path.basename(String(f?.path || ""))).join(" ")}`;
    const documents = skillDocuments();
    const shadow = {
      turn: crypto.randomBytes(6).toString("hex"),
      script: CJK_RE.test(String(text || "")) ? "cjk" : "latin",
      eligible: new Set(documents.map((doc) => doc.id)),
      seen: new Set(),
      rankings: {
        rules: rankSkillCapabilityGraph({ text, files, maxSkills: RANK_LIMIT }).map((item) => item.skill.id),
        bm25: lexicalRank(query, documents).slice(0, RANK_LIMIT),
      },
    };
    state.skillRoutingShadow = shadow;
    appendEvent({ kind: "turn", turn: shadow.turn, script: shadow.script, shadow: isShadow() });
    return shadow;
  } catch {
    return null;
  }
}

/** A tool call opened a skill guide: score every selector on it (once per skill per turn). */
function recordInvocation(state, tool) {
  try {
    const shadow = state?.skillRoutingShadow;
    const skill = skillIdFromTool(tool);
    if (!shadow || !skill || shadow.seen.has(skill)) return null;
    shadow.seen.add(skill);
    const inCatalog = shadow.eligible.has(skill);
    const events = Object.entries(shadow.rankings).map(([method, list]) => {
      const rank = inCatalog ? list.indexOf(skill) + 1 : 0;
      return { kind: "invocation", turn: shadow.turn, method, skill, inCatalog, hit: rank > 0, rank: rankBucket(rank), script: shadow.script, shadow: isShadow() };
    });
    for (const event of events) appendEvent(event);
    return events;
  } catch {
    return null;
  }
}

module.exports = { beginTurn, isShadow, lexicalRank, rankBucket, recordInvocation, skillDocuments, skillIdFromTool, LOG_FILE };
