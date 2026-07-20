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

function safeExternalFactFallback({ policy = null, evidenceSummary = null, userText = "", recoveryAttempt = false } = {}) {
  const language = answerLanguage(userText);
  if (policy?.scopeClarificationRequired) {
    return {
      zh: "这个结论缺少一个无法安全代选的关键范围。请确认需要覆盖的对象、地区或市场、时间点，以及采用的定义或判断标准；明确后我再核验。",
      ar: "يفتقد هذا الاستنتاج نطاقا أساسيا لا يمكن اختياره بأمان. يرجى تحديد الجهات والمنطقة أو السوق والنقطة الزمنية ومعيار الحكم، ثم يمكنني التحقق.",
      en: "A material scope choice cannot be selected safely. Please specify the entities, jurisdiction or market, time point, and decision criterion, then I can verify it.",
    }[language];
  }
  if (policy?.researchProhibited) {
    return {
      zh: "这个问题依赖会变化的外部事实；你要求不搜索或不查验来源，因此我无法可靠确认具体结论，也不能把记忆中的答案当作已确认事实。",
      ar: "يعتمد السؤال على حقائق خارجية متغيرة، ومع منع البحث أو التحقق لا يمكنني تقديم نتيجة محددة من الذاكرة على أنها مؤكدة.",
      en: "This depends on changing external facts. Because research or source checking was prohibited, I cannot present a specific memory-based conclusion as confirmed.",
    }[language];
  }
  if (evidenceSummary?.hasFreshEvidence) {
    const strict = policy?.verificationPlan?.sourceAuthority === "official_primary" ||
      policy?.verificationPlan?.entityEvidenceRequired;
    if (strict) {
      // Fail-CLOSED remainder: only high-stakes asks (or empty-content/fabrication
      // cases the bounded composer refused) reach this text — ordinary turns with
      // real research are intercepted earlier by composeFramedBoundedAnswer.
      const strictBody = {
        zh: `${recoveryAttempt ? "平台已更换策略自动复核一次，但" : "现有材料仍"}没有用负责认定或监管机构的一手材料，或原始发布者材料逐项闭合证据。当前能可靠确定的是：目录顺序、相邻条目、搜索摘要和行业俗称都不能代替正式认定；没有直接证据的具体对象不会被补进答案。`,
        ar: "لم تغلق المواد الحالية سلسلة الأدلة لكل بند بمصدر أولي من الجهة المسؤولة. ترتيب الدليل وملخصات البحث والتسميات الشائعة لا تعوض الإثبات المباشر، لذلك لن تضاف جهات غير مثبتة.",
        en: `${recoveryAttempt ? "The platform changed strategy and retried once, but " : "The available material "}still does not close the item-level evidence chain with primary sources from the responsible authority or original publisher. Directory order, neighboring entries, search snippets, and industry shorthand cannot replace direct evidence, so unsupported entities are omitted.`,
      }[language];
      return strictBody;
    }
    return {
      zh: `${recoveryAttempt ? "平台已自动换策略复核一次；" : ""}本轮材料不足以逐项支撑全部结论，不能把未核实的排行、价格、数字或对象补成完整答案。已确认部分应单独交付，其余明确标为未验证。`,
      ar: "تدعم مواد هذه الجولة جزءا فقط من النتيجة، ولا يجوز إكمال ترتيب أو سعر أو رقم أو جهة غير متحققة. يجب تقديم الجزء المؤكد وحده ووسم الباقي بأنه غير متحقق.",
      en: `${recoveryAttempt ? "The platform changed strategy and retried once. " : ""}This pass supports only part of the conclusion; unverified rankings, prices, numbers, or entities cannot be completed into a full-looking answer. The supported portion should stand alone and the remainder must be marked unverified.`,
    }[language];
  }
  return {
    zh: "本轮没有取得可核验的实时来源，因此不能把记忆补成一个看似具体的答案。",
    ar: "لم أحصل في هذه الجولة على مصدر آني قابل للتحقق، لذلك لن أكمل الفجوة بإجابة تبدو محددة من الذاكرة.",
    en: "This pass did not obtain a verifiable current source, so I will not fill the gap with a specific-looking answer from memory.",
  }[language];
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

/** verification-status banner for a bounded (kept-but-labeled) answer. */
function boundedAnswerBanner({ language = "en", recoveryAttempt = false, researchProhibited = false } = {}) {
  if (researchProhibited) {
    return {
      zh: "⚠️ 核实说明:应你的要求本轮未联网查证。以下内容基于我已有的知识,请作为待核实信息使用;时效性细节可能已变化。",
      ar: "⚠️ ملاحظة تحقق: بناء على طلبك لم يتم البحث في هذه الجولة. المحتوى التالي من معرفتي الحالية؛ يرجى اعتباره غير متحقق منه وقد تتغير التفاصيل الزمنية.",
      en: "⚠️ Verification note: per your request, no online research was done this pass. The following is from my existing knowledge — treat it as unverified; time-sensitive details may have changed.",
    }[language];
  }
  return {
    zh: `⚠️ 核实说明:${recoveryAttempt ? "平台已自动换策略复核一次,仍" : "本轮"}未能完成来源核实。以下内容以我已有的知识为准(截至训练数据),请作为待核实信息使用;重要决策前请自行确认时效性细节。`,
    ar: `⚠️ ملاحظة تحقق: ${recoveryAttempt ? "أعادت المنصة المحاولة تلقائيا لكن " : ""}لم يكتمل التحقق من المصادر في هذه الجولة. المحتوى التالي من معرفتي الحالية؛ يرجى اعتباره غير متحقق منه وتأكيد التفاصيل الزمنية قبل القرارات المهمة.`,
    en: `⚠️ Verification note: ${recoveryAttempt ? "the platform retried with a changed strategy but " : ""}source verification did not complete this pass. The following reflects my existing knowledge (as of training data) — treat it as unverified and confirm time-sensitive details before important decisions.`,
  }[language];
}

/**
 * Bounded-answer composer — the delivery-content invariant for verify_soft tier:
 * the gate may relabel, trim, or bound content, but it must NEVER reduce the
 * delivered task content to zero while any supported content exists.
 *   1. Claim-specific failures: strip only the unsupported items (salvage).
 *   2. Roster/ranking-critical plans with ZERO fresh external evidence: return
 *      null (caller falls back) — a fabricated roster labeled "unverified" is
 *      still a fabricated roster.
 *   3. Everything else: keep the original answer under a verification banner —
 *      the honest-expert behavior ("as of my knowledge…"), instead of erasing
 *      a useful answer and delivering a zero-content meta-explanation.
 */
function composeBoundedExternalAnswer({
  assistant = "",
  assessment = null,
  policy = null,
  evidenceSummary = null,
  userText = "",
  recoveryAttempt = false,
  retryPending = false,
  reassess = null,
} = {}) {
  const original = String(assistant || "").trim();
  if (!original) return null;
  const salvaged = salvageSupportedExternalAnswer({ assistant: original, assessment, userText, reassess });
  if (salvaged) return { ...salvaged, bounded: true };
  // Banner-keeping is a FINAL-state move. While an auto-verify retry is about
  // to run, the interim projection stays conservative (the retry's verified
  // answer supersedes it) — an unverified name/number should not flash up only
  // to be corrected seconds later.
  if (retryPending) return null;
  const plan = policy?.verificationPlan || {};
  const reasons = (policy?.reasonCodes || []).map(String);
  // Roster/ranking asks are the fabrication zone: a made-up top-10 labeled
  // "unverified" is still a made-up top-10. They improve only via salvage
  // (supported subset) or the auto-verify retry — never via banner-keeping.
  const rosterCritical = Boolean(plan.entityEvidenceRequired) ||
    (Array.isArray(plan.claimKinds) && plan.claimKinds.includes("ranking")) ||
    reasons.includes("ranking") || reasons.includes("superlative_comparison");
  if (rosterCritical) return null;
  // Claim-specific failure whose unsupported items could NOT be stripped down
  // to a passing subset: the specifics ARE the problem — banner-keeping them
  // would deliver labeled fabrications. Fall back.
  if (SALVAGEABLE_CLAIM_REASONS.includes(assessment?.reason)) return null;
  const language = answerLanguage(userText);
  const banner = boundedAnswerBanner({
    language,
    recoveryAttempt,
    researchProhibited: Boolean(policy?.researchProhibited),
  });
  const kept = original
    .split(/\r?\n/)
    .filter((line) => !COMPLETENESS_CLAIM_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const body = kept || original;
  return {
    assistant: `${banner}\n\n${body}`,
    assessment: {
      ...(assessment || {}),
      ok: false,
      boundedAnswer: true,
    },
    bounded: true,
  };
}

/**
 * Framed bounded answer — the fail-open delivery for ordinary external-fact
 * turns once real research happened. Replaces both the old zero-content
 * refusal and the vocabulary-triggered informal-classification path: it is
 * now driven by the turn judge's semantic verdict (framing.informalLabel /
 * framing.framingNote) or by judge-unavailable fail-open, never by regexes.
 * Guards (literal only):
 *   - fresh evidence exists in the ledger (a researched answer, not memory);
 *   - no judge-ruled conflicts (contradicted content is never banner-kept);
 *   - no ungrounded numbers (numeric grounding caught literal fabrications);
 *   - entities ABSENT from the evidence are fabricated roster members: their
 *     lines are STRIPPED (with a disclosure note), never banner-kept. Entities
 *     present but unproven ("found, assertion unverified") may stay — that is
 *     the honest fail-open state.
 * Completeness claims ("共N家") are always stripped.
 */
function composeFramedBoundedAnswer({
  assistant = "",
  assessment = null,
  evidenceSummary = null,
  evidenceText = "",
  userText = "",
  recoveryAttempt = false,
  framing = null,
} = {}) {
  const original = String(assistant || "").trim();
  if (!original) return null;
  if (!evidenceSummary?.hasFreshEvidence) return null;
  if (Array.isArray(assessment?.conflictingClaims) && assessment.conflictingClaims.length) return null;
  // Ungrounded numbers are literal fabrications (numeric grounding caught
  // digits absent from every tool output) — never banner-kept.
  if (Array.isArray(assessment?.ungroundedNumbers) && assessment.ungroundedNumbers.length) return null;
  const language = answerLanguage(userText);
  const unsupportedLabels = (Array.isArray(assessment?.unsupportedClaims) ? assessment.unsupportedClaims : [])
    .map(claimLabel)
    .filter(Boolean);
  let absentNormalized = [];
  if (unsupportedLabels.length) {
    const normalizedEvidence = normalizeComparable(evidenceText);
    if (!normalizedEvidence && unsupportedLabels.length) return null;
    absentNormalized = unsupportedLabels
      .filter((label) => !normalizedEvidence.includes(normalizeComparable(label)))
      .map(normalizeComparable)
      .filter(Boolean);
  }
  const kept = original
    .split(/\r?\n/)
    .filter((line) => !COMPLETENESS_CLAIM_RE.test(line))
    .filter((line) => {
      if (!absentNormalized.length) return true;
      const normalizedLine = normalizeComparable(line);
      return !absentNormalized.some((label) => normalizedLine.includes(label));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!kept) return null;
  // Fabricated entities had to survive stripping for the keep to be honest.
  if (absentNormalized.length && kept === original) return null;
  const strippedNote = absentNormalized.length
    ? {
        zh: "附注：本轮证据中未出现的对象已从上方名单移除；保留内容未经逐项核实。",
        ar: "ملاحظة: أزيلت من القائمة جهات لم ترد في أدلة هذه الجولة؛ والمحتوى المتبقي غير مثبت بندا ببندا.",
        en: "Note: entities absent from this turn's evidence were removed from the list above; the remaining content is not item-verified.",
      }[language]
    : "";
  const informalBanner = {
    zh: `⚠️ 口径说明：${framing?.framingNote || "这类称呼是行业俗称或对底层事实的解释，并非官方正式认定。以下内容基于本轮查到的公开材料整理，未逐项取得官方认定，请以官方发布为准。"}`,
    ar: `⚠️ ملاحظة حول المعيار: ${framing?.framingNote || "هذا الوصف اصطلاح شائع أو تفسير لحقائق أساسية وليس تصنيفا رسميا. المحتوى التالي مبني على مواد هذه الجولة دون إثبات رسمي لكل بند؛ يرجى الرجوع إلى النشر الرسمي."}`,
    en: `⚠️ Framing note: ${framing?.framingNote || "This label is an informal convention or an interpretation of underlying facts, not a formal official designation. The following is based on material retrieved this turn without per-item official confirmation; defer to official releases."}`,
  }[language];
  const banner = framing?.informalLabel
    ? informalBanner
    : boundedAnswerBanner({ language, recoveryAttempt, researchProhibited: false });
  return {
    assistant: `${banner}\n\n${kept}${strippedNote ? `\n\n${strippedNote}` : ""}`,
    assessment: {
      ...(assessment || {}),
      ok: false,
      boundedAnswer: true,
      framedBounded: true,
      informalLabelFramed: framing?.informalLabel === true,
      ...(absentNormalized.length ? { strippedFabricatedClaims: true } : {}),
    },
    bounded: true,
  };
}

/** Prepend the judge's framing note to a PASSING answer — the claims are
 *  supported, but the label itself is an informal convention and the user
 *  deserves that caveat up front. */
function prependFramingNote(assistant = "", framing = null, userText = "") {
  const text = String(assistant || "").trim();
  if (!text || framing?.informalLabel !== true) return String(assistant || "");
  const language = answerLanguage(userText);
  const banner = {
    zh: `⚠️ 口径说明：${framing?.framingNote || "这类称呼是行业俗称或对底层事实的解释，并非官方正式认定。"}`,
    ar: `⚠️ ملاحظة حول المعيار: ${framing?.framingNote || "هذا الوصف اصطلاح شائع أو تفسير لحقائق أساسية وليس تصنيفا رسميا."}`,
    en: `⚠️ Framing note: ${framing?.framingNote || "This label is an informal convention or an interpretation of underlying facts, not a formal official designation."}`,
  }[language];
  return `${banner}\n\n${text}`;
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
  boundedAnswerBanner,
  buildEvidenceRecoveryHint,
  composeBoundedExternalAnswer,
  composeFramedBoundedAnswer,
  initialResearchRequirements,
  prependFramingNote,
  repairAnswerCitations,
  safeExternalFactFallback,
  salvageSupportedExternalAnswer,
};
