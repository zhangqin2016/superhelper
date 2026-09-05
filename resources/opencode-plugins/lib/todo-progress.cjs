"use strict";
/**
 * Todo-progress inference — the platform's view of "how far did the plan get",
 * derived from what actually executed, independent of whether the model
 * remembered to update its task list.
 *
 * WHY: the model owns the PLAN (it writes the todo list); the platform owns the
 * EVIDENCE (every tool call and result flows through it). Field case
 * 2026-09-05: a 7-step image-pull task wrote its list once, ran 8 more tools and
 * never touched the list again — the card sat at 0/7 while 4 steps were done.
 * Weak models do this often; strong ones sometimes. Relying on model discipline
 * alone makes the progress card confidently wrong.
 *
 * WHAT: a step is *evidenced* when a SUCCESSFUL tool call's INPUT (the command,
 * path, query…) contains every distinctive identifier that is unique to that
 * step's title — image tags, versions, file names, ids, quoted names. Steps
 * without a unique identifier ("verify all files") are never inferred: silence
 * beats a guess. Inference is an OVERLAY — it never rewrites the model's list,
 * so the model keeps reasoning from its own state (no-dumber invariant).
 *
 * Shared by the OpenCode plugin (Bun, ESM import of this CJS file) and the main
 * process (Node require). Pure, dependency-free, never throws on bad input.
 */

const MIN_TOKEN = 4;
const MAX_TOOLS = 24;
const SNIPPET = 160;
// Generic words that carry no step identity even when long.
const STOP = new Set([
  "docker", "image", "images", "container", "build", "install", "update", "upgrade",
  "download", "upload", "create", "delete", "remove", "verify", "check", "test",
  "tests", "config", "configure", "server", "client", "service", "database",
  "directory", "folder", "file", "files", "archive", "package", "packages",
  "version", "release", "deploy", "deployment", "script", "scripts", "command",
  "true", "false", "null", "http", "https", "localhost", "127.0.0.1", "master", "main",
]);

function text(value, limit = 4000) {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, limit);
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}

/** Stable text view of a tool result across the shapes engines pass around. */
function resultText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output.output === "string") return output.output;
  if (Array.isArray(output.content)) {
    return output.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
  }
  if (typeof output.text === "string") return output.text;
  if (typeof output.result === "string") return output.result;
  return text(output);
}

function cleanToken(raw) {
  return String(raw || "")
    .replace(/^[\s"'`“”‘’«»「」『』《》()[\]{}<>,;:!?，。；：！？、]+|[\s"'`“”‘’«»「」『』《》()[\]{}<>,;:!?，。；：！？、]+$/g, "")
    .toLowerCase();
}

function isDistinctive(tok) {
  if (tok.length < MIN_TOKEN) return false;
  if (STOP.has(tok)) return false;
  if (/^\d{1,3}$/.test(tok)) return false;
  // Identifiers: contain a digit or inner punctuation (tags, versions, paths,
  // ids, hostnames), or are long rare words (≥10 chars, e.g. project slugs).
  if (/\d/.test(tok)) return true;
  if (/[._:/@#-]/.test(tok.slice(1, -1))) return true;
  return tok.length >= 10;
}

/** Identifiers that tie a step title to the tool call that performs it. */
function extractStepTokens(title) {
  const s = String(title || "");
  const out = new Set();
  // Quoted names first — the author marked them as the thing being acted on.
  const quoted = s.match(/["“„«「『《`']([^"”«»「」『』《》`']{2,80})["”»「」『』》`']/g) || [];
  for (const q of quoted) {
    const inner = cleanToken(q.slice(1, -1));
    if (inner && inner.length >= 2 && !STOP.has(inner)) out.add(inner);
  }
  const words = s.match(/[A-Za-z0-9_][A-Za-z0-9_.:@/#-]*[A-Za-z0-9_]|[A-Za-z0-9]{4,}/g) || [];
  for (const w of words) {
    const tok = cleanToken(w);
    if (isDistinctive(tok)) out.add(tok);
  }
  return [...out];
}

/** Per-step token sets split into tokens unique to that step vs shared across
 *  steps ("safar" shared by seven steps proves nothing about any one of them). */
function computeStepTokenSets(titles) {
  const sets = (Array.isArray(titles) ? titles : []).map((t) => extractStepTokens(t));
  const freq = new Map();
  for (const set of sets) for (const tok of set) freq.set(tok, (freq.get(tok) || 0) + 1);
  return sets.map((set) => ({
    unique: set.filter((tok) => freq.get(tok) === 1),
    shared: set.filter((tok) => freq.get(tok) > 1),
  }));
}

function isOk(status) {
  const s = String(status || "").toLowerCase();
  return !s || s === "done" || s === "completed" || s === "success" || s === "ok";
}

/** Compact, comparable record of one tool call for the inference window. */
function compactTool(tool = {}) {
  const src = tool && typeof tool === "object" ? tool : {};
  // Idempotent: an already-compact record keeps its verdict (ok/running) — a
  // failed call must not become "ok" just because it was compacted twice.
  const already = src.inputText != null && typeof src.ok === "boolean";
  const name = String(src.name || src.tool || "");
  const input = src.inputText != null ? String(src.inputText) : text(src.input ?? src.args ?? "", 2000);
  const output = src.outputText != null ? String(src.outputText) : resultText(src.result ?? src.output).slice(0, 2000);
  const running = src.running === true || String(src.status || "").toLowerCase() === "running";
  return {
    id: String(src.id || src.callID || ""),
    name,
    inputText: input,
    outputText: output,
    ok: running ? false : already ? src.ok : isOk(src.status) && src.isError !== true,
    running,
  };
}

function snippetAround(haystack, needle) {
  const idx = haystack.toLowerCase().indexOf(needle);
  if (idx < 0) return haystack.slice(0, SNIPPET);
  const start = Math.max(0, idx - 40);
  return haystack.slice(start, start + SNIPPET).replace(/\s+/g, " ").trim();
}

/**
 * Infer progress for steps the model has not marked completed.
 * @param {Array<{title:string,status?:string}>} steps  the model's plan, in order
 * @param {Array<object>} tools  tool calls observed since the plan was last written
 * @returns {Array<{index:number,inferred:null|"evidenced"|"active",toolId:string,toolName:string,snippet:string}>}
 */
function inferPlanProgress(steps, tools) {
  const list = Array.isArray(steps) ? steps : [];
  const window = (Array.isArray(tools) ? tools : []).slice(-MAX_TOOLS).map(compactTool);
  const sets = computeStepTokenSets(list.map((s) => (s && (s.title || s.content)) || ""));
  return list.map((step, index) => {
    const base = { index, inferred: null, toolId: "", toolName: "", snippet: "" };
    const status = String((step && step.status) || "").toLowerCase();
    if (status === "completed" || status === "done") return base;
    const { unique } = sets[index] || { unique: [] };
    if (!unique.length) return base;
    // Latest matching call wins: a step re-run after a failure is judged by its
    // final attempt, and a still-running match reads as "active".
    for (let i = window.length - 1; i >= 0; i -= 1) {
      const tool = window[i];
      if (tool.name.toLowerCase() === "todowrite") continue;
      const hay = tool.inputText.toLowerCase();
      if (!unique.every((tok) => hay.includes(tok))) continue;
      if (tool.running) return { ...base, inferred: "active", toolId: tool.id, toolName: tool.name, snippet: snippetAround(tool.inputText, unique[0]) };
      if (tool.ok) return { ...base, inferred: "evidenced", toolId: tool.id, toolName: tool.name, snippet: snippetAround(tool.inputText, unique[0]) };
      // A failed final attempt: nothing to claim; keep scanning older calls is
      // wrong (they are superseded) — stop here.
      return base;
    }
    return base;
  });
}

function localeKind(locale) {
  const l = String(locale || "").toLowerCase();
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("ar")) return "ar";
  return "en";
}

function joinIndexes(indexes, kind) {
  const sep = kind === "zh" ? "、" : kind === "ar" ? "، " : ", ";
  return indexes.map((i) => String(i + 1)).join(sep);
}

/**
 * The reminder appended to a tool result when the list has gone stale. Names
 * the steps the execution record already supports so a weak model only has to
 * confirm, and asks for a STATUS-ONLY update so the list is not rewritten.
 */
function buildNudgeNote({ locale, sinceCount, steps, inference }) {
  const kind = localeKind(locale);
  const list = Array.isArray(steps) ? steps : [];
  const total = list.length;
  const done = list.filter((s) => String((s && s.status) || "").toLowerCase() === "completed").length;
  const evidenced = (Array.isArray(inference) ? inference : []).filter((r) => r && r.inferred === "evidenced");
  const idx = evidenced.map((r) => r.index);
  const firstTitle = evidenced.length ? String(list[idx[0]]?.content || list[idx[0]]?.title || "").slice(0, 40) : "";
  if (kind === "zh") {
    const hint = evidenced.length
      ? `据执行记录，第 ${joinIndexes(idx, kind)} 项${firstTitle ? `（如「${firstTitle}」）` : ""}看起来已完成。`
      : "";
    return `[plan] 任务清单已 ${sinceCount} 步未更新（已确认 ${done}/${total}）。${hint}请用 todowrite 把已完成的项标为 completed、当前进行的一项标为 in_progress；只更新状态，不要改写内容。`;
  }
  if (kind === "ar") {
    const hint = evidenced.length
      ? `وفق سجل التنفيذ، تبدو الخطوات ${joinIndexes(idx, kind)} مكتملة.`
      : "";
    return `[plan] لم تُحدَّث قائمة المهام منذ ${sinceCount} خطوات (المؤكد ${done}/${total}). ${hint} استخدم todowrite لتعليم الخطوات المنجزة completed والخطوة الجارية in_progress؛ حدِّث الحالة فقط دون إعادة كتابة المحتوى.`;
  }
  const hint = evidenced.length
    ? `Per the execution record, step${idx.length > 1 ? "s" : ""} ${joinIndexes(idx, kind)}${firstTitle ? ` (e.g. "${firstTitle}")` : ""} look${idx.length > 1 ? "" : "s"} done. `
    : "";
  return `[plan] The task list has not been updated for ${sinceCount} steps (${done}/${total} confirmed). ${hint}Use todowrite to mark finished items completed and the current one in_progress; update statuses only, do not rewrite the items.`;
}

module.exports = {
  MAX_TOOLS,
  buildNudgeNote,
  compactTool,
  computeStepTokenSets,
  extractStepTokens,
  inferPlanProgress,
  localeKind,
  resultText,
};
