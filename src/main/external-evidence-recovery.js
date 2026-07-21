"use strict";

function answerLanguage(value = "") {
  const text = String(value || "");
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  if (/[\u0600-\u06ff]/u.test(text)) return "ar";
  return "en";
}

function planFlags(value = null) {
  const plan = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    sourceAuthority: String(plan.sourceAuthority || "standard"),
    classificationEvidenceRequired: Boolean(plan.classificationEvidenceRequired),
    entityEvidenceRequired: Boolean(plan.entityEvidenceRequired),
    claimEvidenceRequired: Boolean(plan.claimEvidenceRequired),
    ranking: Array.isArray(plan.claimKinds) && plan.claimKinds.includes("ranking"),
  };
}

function initialResearchRequirements(value = null) {
  const plan = planFlags(value);
  const requirements = [
    "Use broad search only to discover candidate sources or entities. After identifying the source owner, switch to the original publisher or responsible authority, open the source page, and treat snippets and secondary summaries only as leads.",
    "Keep a claim-to-evidence map while researching. Deliver every supported conclusion or an honestly labeled supported subset; do not discard verified findings merely because the requested roster is not exhaustive.",
  ];
  if (plan.classificationEvidenceRequired) {
    requirements.push(
      "Verify the premise before building the roster: determine whether the requested label is a formal classification. If it is informal, say so, support the underlying formal facts with primary material, and separate those facts from the resulting interpretation.",
    );
  }
  if (plan.ranking) {
    requirements.push(
      "For a ranking, choose one named publisher or benchmark whose scope and method match the request; do not merge incompatible lists into a synthetic ranking.",
    );
  }
  return requirements;
}

function previousResearchSummary(evidenceSummary = null, language = "en") {
  const events = Array.isArray(evidenceSummary?.events) ? evidenceSummary.events : [];
  const researchEvents = events.filter((event) =>
    ["web_search", "web_fetch", "external_observation"].includes(event?.kind));
  if (!researchEvents.length) return "";
  return language === "zh"
    ? `上轮已执行 ${researchEvents.length} 次外部检索或读取；不要原样重复这些检索。`
    : `The prior pass already made ${researchEvents.length} external lookups; do not repeat them unchanged.`;
}

function reasonRecoveryStep(reason = "", language = "en") {
  const value = String(reason || "");
  if (/authoritative_source_required/.test(value)) {
    return language === "zh"
      ? "上轮来源层级不够或使用了间接推断。不要重复同一条宽泛搜索；先确定负责定义、监管、认定、任免或发布该事实的官方机构，再用机构名称和原始术语检索；发现官方域名后用 site:<域名> 收敛，并打开原始页面。"
      : "The prior source tier was too weak or the answer used an indirect inference. Do not repeat the same broad query. Identify the responsible regulator, accreditor, appointing authority, registry, or original publisher; search with that owner and the source terminology, then use site:<host> and open the original page.";
  }
  if (/entity_claim_|external_claim_not_in_evidence/.test(value)) {
    return language === "zh"
      ? "上轮证据没有逐项覆盖答案。把二手名单仅作为候选池，逐项查原始记录；最终保留有直接证据的对象，并把完整性明确标为完整或部分。"
      : "The prior evidence did not cover the answer item by item. Use secondary rosters only as a candidate pool, verify each one against primary material, and label the resulting coverage as complete or partial.";
  }
  if (/numeric_claim_not_in_evidence/.test(value)) {
    return language === "zh"
      ? "上轮具体数字没有进入证据链。查到原始数据后再保留数字；否则删除具体值，按证据真实支持的强度作答。"
      : "The prior numbers were outside the evidence chain. Keep a number only after finding its original data; otherwise remove the value and answer at the strength the evidence supports.";
  }
  if (/source_link_not_in_evidence|external_fact_without_source_link/.test(value)) {
    return language === "zh"
      ? "上轮引用不合格。打开来源页面，只引用本轮工具真实返回且直接支撑相邻结论的链接。"
      : "The prior citations were inadequate. Open the source pages and cite only links returned by the tools that directly support the adjacent conclusion.";
  }
  return language === "zh"
    ? "先判断缺的是来源、范围、逐项覆盖还是定义本身，再选择能补上该缺口的工具和来源；不要重复没有新增证据的动作。"
    : "First determine whether the gap is source authority, scope, item coverage, or the definition itself, then choose a tool and source that can close that gap; do not repeat actions that add no evidence.";
}

function buildEvidenceRecoveryHint({ language = "en", reason = "", verificationPlan = null, evidenceSummary = null } = {}) {
  const plan = planFlags(verificationPlan);
  const prior = previousResearchSummary(evidenceSummary, language);
  const zh = language === "zh";
  const lines = zh ? [
    "[系统纠正：证据恢复] 上一轮没有达到证据门槛。这是本次任务唯一一次自动恢复；必须改变研究策略并交付证据实际支持的最有用答案。",
    "1. 断言前先用工具核实。外部事实使用 websearch/webfetch、实时权威 API 或权威原始文件；只引用工具真实返回的链接，并打开核对。",
    "2. 宽泛搜索只用于发现来源负责人或候选对象。搜索摘要、聚合文章和二手名单是线索，不是最终证据。",
    `3. ${reasonRecoveryStep(reason, "zh")}`,
    "4. 建立逐项证据映射。无法证明的具体对象、数字或属性不要写成事实；不要因为部分候选未证实，就丢掉已经证实的结果。",
    "5. 最终回答必须直接回应用户：先给已证实结论或明确标注的已证实子集，再写口径、日期、来源和未覆盖边界。只要存在受支持的结论，就不要只回复研究过程或笼统拒绝。",
    "6. 对可逆歧义，不要只把范围问题抛回用户；采用合理默认口径并公开说明。只有缺少用户选择就完全无法给出有用结果时才提问。",
  ] : [
    "[system correction: evidence recovery] The prior pass did not clear the evidence gate. This is the task's only automatic recovery pass: change the research strategy and deliver the most useful answer the evidence supports.",
    "1. Before asserting a fact, verify it with a tool. For external facts, use websearch/webfetch or a live authoritative API; an authoritative original file is also valid. Cite only tool-returned links that you opened and checked.",
    "2. Use broad search only to discover the responsible source owner or candidate entities. Search snippets, aggregators, and secondary rosters are leads, not final evidence.",
    `3. ${reasonRecoveryStep(reason, "en")}`,
    "4. Build an item-level evidence map. Do not state an unsupported entity, number, or attribute as fact, and do not discard supported findings merely because other candidates remain unverified.",
    "5. The final answer must directly answer the user: give the verified conclusion or clearly labeled verified subset first, then scope, date, sources, and coverage limits. If any supported conclusion exists, do not return only process narration or a blanket refusal.",
    "6. For reversible ambiguity, do not return only a scope question; use a reasonable disclosed default. Ask only when no useful result is possible without the user's choice.",
  ];
  if (plan.classificationEvidenceRequired) {
    lines.push(zh
      ? "7. 先验证分类前提：该标签是正式认定，还是行业俗称/对底层事实的解释？若官方材料只证明底层事实，就明确区分“官方事实”和“据此作出的解释”，不要寻找并不存在的官方完整名单。"
      : "7. Verify the classification premise first: is the label formally conferred, or is it industry shorthand or an interpretation of underlying facts? If primary material proves only the underlying facts, separate official fact from interpretation instead of demanding an official roster that may not exist.");
  } else if (plan.ranking) {
    lines.push(zh
      ? "7. 排行只能采用一个名称明确、口径匹配且有日期/方法说明的发布者或基准；不要把多个不兼容榜单拼成新排行。"
      : "7. A ranking must use one named publisher or benchmark with a matching scope, date, and method; do not synthesize a new ranking from incompatible lists.");
  }
  if (prior) lines.push(prior);
  return lines.join("\n");
}

function claimLabel(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value.label === "string") return value.label.trim();
  return "";
}

function normalizeComparable(value = "") {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

const COMPLETENESS_CLAIM_RE =
  /(?:共|合计|总计|仅|只有)\s*[一二三四五六七八九十百\d]+\s*(?:家|个|所|项|名)?|(?:完整|全部|全量|唯一)(?:名单|列表|结果)?|\b(?:total|only)\s+\d+\b|\b(?:complete|exhaustive)\s+(?:list|roster|result)/i;

const SALVAGEABLE_CLAIM_REASONS = [
  "entity_claim_not_in_evidence",
  "entity_claim_conflicts_with_evidence",
  "external_claim_not_in_evidence",
  "numeric_claim_not_in_evidence",
];

function salvageSupportedExternalAnswer({ assistant = "", assessment = null, userText = "", reassess = null } = {}) {
  if (typeof reassess !== "function") return null;
  if (!SALVAGEABLE_CLAIM_REASONS.includes(assessment?.reason)) return null;
  const labels = [...new Set([
    ...(Array.isArray(assessment?.unsupportedClaims) ? assessment.unsupportedClaims : []),
    ...(Array.isArray(assessment?.conflictingClaims) ? assessment.conflictingClaims : []),
  ].map(claimLabel).filter(Boolean))];
  const claimCount = Number(assessment?.entityCoverage?.claimCount || 0);
  if (!labels.length || (claimCount > 0 && labels.length >= claimCount)) return null;
  const normalizedLabels = labels.map(normalizeComparable).filter(Boolean);
  const keptLines = String(assistant || "").split(/\r?\n/).filter((line) => {
    if (COMPLETENESS_CLAIM_RE.test(line)) return false;
    const normalizedLine = normalizeComparable(line);
    return !normalizedLabels.some((label) => normalizedLine.includes(label));
  });
  const candidate = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!candidate || candidate === String(assistant || "").trim()) return null;
  // The surviving subset must still SAY something. If stripping the unsupported
  // claims leaves only headings/citations, the salvage no longer answers the
  // question — fall through to the tier logic (which preserves the real failure
  // reason) instead of delivering a hollow shell marked ok. A content line is
  // one that still carries prose after URL removal and is not a bare heading.
  const hasContentLine = candidate.split(/\r?\n/).some((line) => {
    const withoutUrls = line.replace(/https?:\/\/[^\s<>"]+/g, "").trim();
    if (!withoutUrls || /[：:]\s*$/.test(withoutUrls)) return false;
    return /[\p{L}\p{N}]/u.test(withoutUrls.replace(/^[\s\d.、)(]+/u, ""));
  });
  if (!hasContentLine) return null;
  const disclosure = answerLanguage(userText) === "zh"
    ? "仅列出本轮一手证据能够逐项支持的对象；未获逐项证明或存在冲突的候选未列入。"
    : "Only items supported individually by primary evidence from this pass are listed; unsupported or conflicting candidates are omitted.";
  const projected = `${candidate}\n\n${disclosure}`;
  const nextAssessment = reassess(projected);
  if (nextAssessment?.ok !== true) return null;
  return {
    assistant: projected,
    assessment: {
      ...nextAssessment,
      salvagedSupportedSubset: true,
      removedClaims: labels.slice(0, 10),
    },
  };
}

/**
 * Citation repair — a citation-DISCIPLINE failure must not destroy real
 * research. Two deterministic, honest moves (no model call):
 *   1. Fabricated citations (URLs absent from this turn's tool evidence) are
 *      STRIPPED — a made-up link may never be delivered.
 *   2. When the answer then carries no grounded citation but the evidence
 *      ledger holds real source URLs, a truthful "sources consulted this turn"
 *      section is appended, listing ONLY urls that actually appear in the tool
 *      evidence (so the re-run's grounding check passes on merit).
 * The full gate re-runs afterwards: authority tier, entity/claim coverage and
 * conflicts all still apply, so repair cannot launder unsupported claims —
 * it only fixes the citation LAYER. Returns null when there is nothing honest
 * to repair with (e.g. the ledger is empty — retrieval genuinely failed).
 */
function repairAnswerCitations({
  assistant = "",
  evidenceText = "",
  evidenceSummary = null,
  assessment = null,
  userText = "",
} = {}) {
  const original = String(assistant || "").trim();
  if (!original) return null;
  const reason = String(assessment?.reason || "");
  if (!["external_fact_without_source_link", "source_link_not_in_evidence"].includes(reason)) return null;
  const { extractHttpUrls, normalizeHttpUrl } = require("./external-source-authority");
  const groundedUrls = extractHttpUrls(evidenceText);
  if (!groundedUrls.length) return null;
  const groundedSet = new Set(groundedUrls.map(normalizeHttpUrl));

  // 1. Strip fabricated citations.
  let repaired = original;
  const answerUrls = extractHttpUrls(original);
  const strippedUrls = answerUrls.filter((url) => !groundedSet.has(normalizeHttpUrl(url)));
  for (const url of strippedUrls) {
    repaired = repaired.split(url).join("");
  }
  repaired = repaired
    .replace(/[（(]\s*[；;，,、\s]*[)）]/g, "")
    .replace(/(?:来源|Source|المصدر)\s*[:：]\s*$/gim, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!repaired) return null;

  // 2. Append the truthful sources section when no grounded citation remains.
  const remaining = extractHttpUrls(repaired).filter((url) => groundedSet.has(normalizeHttpUrl(url)));
  let appendedSources = [];
  if (!remaining.length) {
    // Prefer pages that were actually OPENED this turn (web_fetch inputs),
    // then any url present in the tool evidence. Both sets are restricted to
    // urls that appear in evidenceText, so grounding passes on merit.
    const fetched = (Array.isArray(evidenceSummary?.events) ? evidenceSummary.events : [])
      .filter((event) => event?.kind === "web_fetch")
      .map((event) => String(event.query || ""))
      .filter((url) => groundedSet.has(normalizeHttpUrl(url)));
    appendedSources = [...new Set([...fetched, ...groundedUrls])].slice(0, 5);
    if (!appendedSources.length) return null;
    const language = answerLanguage(userText);
    const heading = { zh: "本轮检索来源:", ar: "المصادر المسترجعة في هذه الجولة:", en: "Sources consulted this turn:" }[language];
    repaired = `${repaired}\n\n${heading}\n${appendedSources.map((url) => `- ${url}`).join("\n")}`;
  }
  if (repaired === original) return null;
  return { assistant: repaired, strippedUrls, appendedSources };
}

module.exports = {
  answerLanguage,
  buildEvidenceRecoveryHint,
  initialResearchRequirements,
  repairAnswerCitations,
  salvageSupportedExternalAnswer,
};
