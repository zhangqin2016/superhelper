"use strict";

/**
 * The agent guide's skill index and its byte budget.
 *
 * The guide is injected as hidden context on every prompt, and this index is
 * the ONLY channel that tells the model which skills exist — the engine's
 * native skill loading is unused. The index is assembled last, from whatever
 * bytes the fixed guide prefix leaves over, so entries that do not fit are
 * dropped. That used to happen silently; everything here reports it instead.
 *
 * Extracted from skill-manager.js, which was at its line ratchet. The index
 * building, the budget arithmetic and the measurement are one concern.
 */

const { getLogger } = require("./logger");

const guideLog = getLogger("agent-guide");

/** Bump when static AGENT.md header or mandatory guide semantics change. */
const AGENT_GUIDE_MAX_BYTES = 48 * 1024;

/** Share of the budget above which the index has almost no room for another
 *  skill, so the next one enabled starts disappearing. Shared with
 *  scripts/test-agent-guide-headroom.mjs. */
const AGENT_GUIDE_WATERMARK = 0.95;

const SKILL_INDEX_I18N = {
  "zh-CN": {
    title: "Lily 平台能力目录（使用前先读取对应指南）",
    intro:
      "以下是本会话可用的 Lily 平台能力指南，不是 OpenCode 原生 skill。对每个用户请求：先按“适用场景”匹配能力（可多选并组合成能力链），在动手前用 Read 工具读取对应指南文件以获得完整步骤，再通过 Lily MCP 工具、脚本或普通工具执行。禁止对这些平台能力执行原生 `skill <id>`，包括 `lily-*` 和内置 `anthropics-*`。",
    guideLabel: "指南",
    truncated: "技能目录已截断以保护提示词预算；如需更多能力，请通过设置里的技能目录或按任务关键词搜索/启用对应技能。",
  },
  en: {
    title: "Lily Platform Capability Catalog (read the guide before using a capability)",
    intro:
      "These are Lily platform capability guides available in this session, not OpenCode native skills. For each user request: match capabilities by their \"use when\" description (you may pick several and compose a capability chain), then READ the guide file with the Read tool before acting, and execute through Lily MCP tools, scripts, or ordinary tools. Do not run native `skill <id>` for these platform capabilities, including `lily-*` and built-in `anthropics-*` entries.",
    guideLabel: "Guide",
    truncated: "Skill index was truncated to protect the prompt budget; search or enable additional skills by task keyword when needed.",
  },
  ar: {
    title: "فهرس قدرات منصة Lily (اقرأ الدليل قبل استخدام القدرة)",
    intro:
      "هذه أدلة قدرات منصة Lily المتاحة في هذه الجلسة، وليست مهارات OpenCode أصلية. لكل طلب: طابِق القدرات حسب وصف \"استخدمها عند\" (يمكنك اختيار عدة قدرات وتركيبها)، ثم اقرأ ملف الدليل بأداة Read قبل التنفيذ، ونفّذ عبر أدوات Lily MCP أو السكربتات أو الأدوات العادية. لا تشغّل `skill <id>` الأصلي لهذه القدرات، بما في ذلك `lily-*` و`anthropics-*` المدمجة.",
    guideLabel: "الدليل",
    truncated: "تم اختصار فهرس المهارات لحماية ميزانية التعليمات؛ ابحث عن مهارات إضافية أو فعّلها حسب كلمات المهمة عند الحاجة.",
  },
};

function utf8Bytes(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function appendWithinByteBudget(lines, nextLine, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    lines.push(nextLine);
    return true;
  }
  const candidate = [...lines, nextLine].join("\n");
  if (utf8Bytes(candidate) > maxBytes) return false;
  lines.push(nextLine);
  return true;
}

function trimUtf8ToBytes(text, maxBytes) {
  const value = String(text || "");
  if (utf8Bytes(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo);
}

/** Shorten a skill description to its leading trigger phrase. Lily's platform
 *  guide lists capability pointers and guide paths; agents read the full
 *  SKILL.md only for matched capabilities. Duplicating the whole description
 *  here dilutes every turn and tempts models to treat the entry as a native
 *  OpenCode `skill` command. */
const { shortIndexDesc, indexDesc } = require("./skill-index-description");

/** Build the progressive-disclosure skill index: every enabled skill listed with
 *  a SHORT when-to-use trigger and the path to its full guide, read on demand
 *  through normal file tools. Keep entries terse so the guide remains a router,
 *  not a second copy of each skill. */
function renderSkillIndexSection(enabledSkills, loc, maxBytes, report, entryOf, opts, describe) {
  const head = { ...(SKILL_INDEX_I18N[loc] || SKILL_INDEX_I18N.en), ...opts };
  const lines = [`## ${head.title}`, "", head.intro, ""];
  let omitted = 0;
  for (const skill of enabledSkills) {
    const e = entryOf(skill, loc);
    // A skill with no description is silently absent from the index, so the
    // model never learns it exists. Record it: at any scale this is a
    // discovery hole, and it is invisible in the produced text.
    if (!e.desc) {
      if (report) report.undescribedIds.push(e.id);
      continue;
    }
    // FULL-WIDTH parentheses, deliberately: gateway WAFs pattern-match code
    // injection as ASCII `eval (` — and a skill id ending in "-eval" followed
    // by " (Name)" tripped one in the field, killing EVERY request that
    // carried the guide (HTTP 200 + empty body, shown as empty completions).
    // Full-width （） reads identically to the model and misses the WAF regex.
    // LILY_GUIDE_ASCII_PARENS=1 restores the ASCII format (escape hatch for
    // debugging; default behavior is the WAF-safe full-width form).
    const asciiParens = process.env.LILY_GUIDE_ASCII_PARENS === "1";
    const guide = e.hasGuide
      ? (asciiParens ? ` (${head.guideLabel}: ${e.guidePath})` : ` （${head.guideLabel}: ${e.guidePath}）`)
      : "";
    const label = e.name && e.name !== e.id
      ? (asciiParens ? `${e.id} (${e.name})` : `${e.id}（${e.name}）`)
      : e.id;
    if (!appendWithinByteBudget(lines, `- **${label}** — ${describe(e.desc)}${guide}`, maxBytes)) {
      omitted += 1;
      if (report) report.omittedIds.push(e.id);
    } else if (report) {
      report.indexedIds.push(e.id);
      report.indexLineBytes += utf8Bytes(lines[lines.length - 1]) + 1;
    }
  }
  if (lines.length <= 4) return "";
  if (omitted > 0) {
    const notice = `- ${head.truncated} (${omitted} omitted)`;
    if (!appendWithinByteBudget(lines, notice, maxBytes)) {
      const popped = lines.pop();
      if (report && report.indexedIds.length) {
        report.omittedIds.push(report.indexedIds.pop());
        report.indexLineBytes -= utf8Bytes(popped) + 1;
      }
      appendWithinByteBudget(lines, notice, maxBytes);
    }
  }
  return lines.join("\n");
}

// Expansion is optional: it must never remove any entry that fit before.
function buildSkillIndexSection(enabledSkills, loc, maxBytes = Infinity, report = null, entryOf = () => ({}), opts = {}) {
  const baselineReport = createIndexReport();
  const baseline = renderSkillIndexSection(enabledSkills, loc, maxBytes, baselineReport, entryOf, opts, shortIndexDesc);
  let chosen = baseline, chosenReport = baselineReport;
  try {
    if (process.env.LILY_GUIDE_INDEX_NEGATIVE !== "0") {
      const expandedReport = createIndexReport();
      const expanded = renderSkillIndexSection(enabledSkills, loc, maxBytes, expandedReport, entryOf, opts, indexDesc);
      if (baselineReport.indexedIds.every(id => expandedReport.indexedIds.includes(id))) {
        chosen = expanded; chosenReport = expandedReport;
      }
    }
  } catch { /* Description enhancement falls back to the exact old index. */ }
  if (report) Object.assign(report, chosenReport);
  return chosen;
}

/** A fresh accumulator for one index build. */
function createIndexReport() {
  return { indexedIds: [], omittedIds: [], undescribedIds: [], indexLineBytes: 0 };
}

/** Last measured guide budget, for diagnostics and the headroom gate. Written
 *  on every build so support can answer "is this install near the wall?". */
let lastAgentGuideBudget = null;

function namedIdList(ids, limit = 12) {
  if (ids.length <= limit) return ids.join(", ");
  return `${ids.slice(0, limit).join(", ")} … and ${ids.length - limit} more`;
}

function reportAgentGuideBudget(generated, prefixBytes, indexBudget, report, loc) {
  const totalBytes = utf8Bytes(generated);
  lastAgentGuideBudget = {
    locale: loc,
    totalBytes,
    maxBytes: AGENT_GUIDE_MAX_BYTES,
    prefixBytes,
    indexBudget,
    indexed: report.indexedIds.length,
    indexedIds: [...report.indexedIds],
    indexLineBytes: report.indexLineBytes,
    omittedIds: [...report.omittedIds],
    undescribedIds: [...report.undescribedIds],
    measuredAt: Date.now(),
  };
  if (report.omittedIds.length) {
    guideLog.warn(
      "skill index dropped %d of %d skills for budget (locale=%s, prefix=%dB, index budget=%dB): %s",
      report.omittedIds.length,
      report.omittedIds.length + report.indexedIds.length,
      loc,
      prefixBytes,
      indexBudget,
      namedIdList(report.omittedIds),
    );
  }
  if (report.undescribedIds.length) {
    guideLog.warn(
      "skills missing a description are absent from the index and undiscoverable: %s",
      namedIdList(report.undescribedIds),
    );
  }
}

/** @returns {null | {totalBytes:number,maxBytes:number,prefixBytes:number,indexed:number,indexedIds:string[],omittedIds:string[],undescribedIds:string[]}} */
function getLastAgentGuideBudget() {
  return lastAgentGuideBudget ? { ...lastAgentGuideBudget } : null;
}

/**
 * Turn the last measurement into the numbers a human acts on: how full the
 * budget is, and how many more average skills fit before entries vanish.
 * Per-skill cost comes from the real index lines, excluding the section's fixed
 * title and intro — folding those into each skill halves the reported headroom.
 */
function summarizeGuideBudget(report) {
  const perSkill = report.indexed > 0 ? report.indexLineBytes / report.indexed : 0;
  const ceiling = Math.floor(AGENT_GUIDE_MAX_BYTES * AGENT_GUIDE_WATERMARK);
  return {
    ...report,
    share: report.totalBytes / AGENT_GUIDE_MAX_BYTES,
    watermarkBytes: ceiling,
    headroomSkills: perSkill > 0 ? Math.max(0, Math.floor((ceiling - report.totalBytes) / perSkill)) : null,
    atRisk: report.omittedIds.length > 0 || report.totalBytes > ceiling,
  };
}

module.exports = {
  AGENT_GUIDE_MAX_BYTES,
  AGENT_GUIDE_WATERMARK,
  SKILL_INDEX_I18N,
  utf8Bytes,
  trimUtf8ToBytes,
  buildSkillIndexSection,
  shortIndexDesc,
  indexDesc,
  createIndexReport,
  reportAgentGuideBudget,
  getLastAgentGuideBudget,
  summarizeGuideBudget,
};
