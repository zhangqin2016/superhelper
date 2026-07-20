"use strict";

const {
  emptyVerificationPlan,
  mergeExternalClaimPlans,
  mergeModelVerificationPlan,
  normalizeVerificationPlan,
  requirementsForPlan,
} = require("./external-claim-profiles");

// Trigger vocabularies cover zh / en / ar — the platform ships all three locales,
// and gate protection must not silently switch off for one language.
const RANKING_PATTERNS = [
  /(?:排行榜?|排名|榜单|第\s*[一二三四五六七八九十百\d]+\s*名|前\s*\d+\s*(?:名|个)?)/i,
  /\b(?:top\s*(?:\d+|ten|twenty|hundred)|rank(?:ing|ed|s)?|leaderboard)\b/i,
  /(?:تصنيف|ترتيب|قائمة\s*أفضل|أفضل\s*\d+|المراكز\s*ال)/i,
];

const SUPERLATIVE_PATTERNS = [
  /(?:哪个|哪些|谁|什么).{0,12}(?:产品|公司|国家|城市|学校|大学|医院|模型|手机|电脑|软件|品牌|景点|餐厅|电影|歌曲|游戏).{0,12}(?:最好|最佳|最强|最高|最低|最多|最少|最受欢迎)/i,
  /(?:最好|最佳|最强|最受欢迎).{0,20}(?:产品|公司|国家|城市|学校|大学|医院|模型|手机|电脑|软件|品牌|景点|餐厅|电影|歌曲|游戏)/i,
  /\b(?:best|most popular|highest|lowest|largest|smallest)\b.{0,32}\b(?:product|company|country|city|school|university|hospital|model|phone|computer|software|brand|restaurant|movie|game)\b/i,
  /(?:الأفضل|الأكثر\s*شعبية|الأعلى|الأكبر|الأقل).{0,40}(?:منتج|شركة|دولة|مدينة|جامعة|مستشفى|هاتف|برنامج|علامة|مطعم|فيلم|لعبة)|(?:منتج|شركة|دولة|مدينة|جامعة|مستشفى|هاتف|برنامج|علامة|مطعم|فيلم|لعبة).{0,40}(?:الأفضل|الأكثر\s*شعبية|الأعلى|الأكبر)/i,
];

const EXPLICIT_WEB_RE =
  /(?:联网|上网|网上查|网络搜索|browse\s+(?:the\s+)?web|search\s+(?:the\s+)?web|search\s+online|verify\s+online|check\s+online|ابحث\s*(?:في|على)\s*(?:الإنترنت|الويب|الشبكة)|تحقق\s*عبر\s*الإنترنت)/i;
const RESEARCH_PROHIBITED_RE =
  /(?:不要|不用|无需|禁止|不许|不可以|别)(?:联网|上网|搜索|检索|查资料|找来源)|(?:不要|不用|无需)(?:给|提供|附)(?:来源|链接|引用)|\b(?:do\s+not|don't|dont|without)\s+(?:search(?:ing)?|brows(?:e|ing)|look(?:ing)?\s+up)|\bno\s+(?:search|sources?|citations?)\b|(?:بدون|دون|لا)\s*(?:بحث|تبحث|إنترنت|مصادر)/i;
const RESEARCH_ALLOWED_RE =
  /(?:可以|允许|请|现在)(?:我|你|系统)?(?:联网|上网|搜索|检索|查资料|找来源)|\b(?:you\s+may|please|now)\s+(?:search|browse|look\s+up)|\bsearch\s+(?:the\s+)?web\s+now\b|يمكنك\s*البحث|ابحث\s*الآن/i;
const CONTEXTUAL_LOOKUP_RE = /(?:搜索一下|查一下|查证|核实|找来源|官网查询|look\s+it\s+up|look\s+up|ابحث\s*عن|تحقق\s*من|تأكد\s*من)/i;
const URL_RE = /https?:\/\/[^\s<>"]+/i;
const FRESHNESS_RE = /(?:最新|最近|当前|现在|目前|今天|今日|实时|截至|现任|刚刚|latest|current|today|recent|real[- ]?time|right now|as of|incumbent|أحدث|الآن|حالي(?:ًا|ا)?|اليوم|مؤخر(?:ًا|ا)|حتى\s*الآن|في\s*الوقت\s*الحالي)/i;
const REQUEST_RE =
  /[?？؟]|(?:什么|多少|几|谁|哪个|哪些|哪家|是否|有没有|告诉我|给我|列出|比较|查|搜索|查询|分析|解读|总结|how much|how many|who is|what is|which|show me|list|compare|find|tell me|ما\s*(?:هو|هي)|من\s*(?:هو|هي)|كم|أي|هل|أخبرني|اعرض|قارن|ابحث)/i;
const CREATIVE_ONLY_RE =
  /(?:写一首|写首|编一个|虚构|纯创作|小说|诗歌|故事|段子|笑话|creative writing|write (?:a|an) (?:poem|story|joke)|fictional|اكتب\s*(?:قصيدة|قصة)|قصة\s*خيالية|نكتة)/i;
// Questions about the ASSISTANT ITSELF (capabilities, identity) are not
// external facts — a time word there ("今天能帮我做什么") is not an evidence
// need. Request-shape guard, not domain vocabulary.
const ASSISTANT_SELF_RE =
  /(?:你.{0,8}(?:能|可以|会).{0,6}(?:做|干)(?:什么|啥)|你会什么|你(?:是|叫)谁|介绍一下你自己|你是谁|what can you do|who are you|ماذا\s*يمكنك\s*(?:أن\s*)?فعل|من\s*أنت)/i;
const OPERATIONAL_ACTION_RE =
  /(?:修复|实现|开发|创建|新建|设计|修改|改造|重构|部署|发布|上线|打包|测试|排查|调试|接入|配置|写代码|fix|implement|build|create|design|edit|refactor|deploy|publish|release|package|test|debug|integrate|configure|أصلح|نف(?:ّ)?ذ|طو(?:ّ)?ر|أنشئ|صم(?:ّ)?م|عد(?:ّ)?ل|انشر|اختبر|اضبط)/i;
const INTERNAL_DATA_RE =
  /(?:我们公司|本公司|公司内部|内部数据|团队成员|员工|销售员|门店|班级|学生成绩|数据库里|表格里|文件里|这份数据|our company|internal data|our team|employees?|sales reps?|class grades?|in (?:the|this) (?:database|spreadsheet|file)|شركتنا|بيانات\s*داخلية|فريقنا|الموظف(?:ون|ين)|في\s*(?:قاعدة\s*البيانات|الجدول|الملف))/i;
const EXTERNAL_SCOPE_RE = /(?:全球|世界|全国|行业|市场|公开榜单|global|worldwide|national|industry|market|public ranking|عالمي|العالم|السوق|الصناعة|تصنيف\s*عام)/i;

// Model-first refactor (2026-07-20): the ONLY domain vocabulary left in the
// gate is the high-stakes floor (medical/legal/finance). It exists solely for
// the fail-CLOSED boundary and turn-start buffering — never for content
// judgment. Every other "is this question about domain X" call is semantic
// and belongs to the model (verification-plan candidate + turn judge).
const DYNAMIC_DOMAINS = Object.freeze([
  ["high_stakes", /(?:医疗|医学|药物|剂量|诊断|治疗|法律意见|诉讼|税务|投资|理财|证券|保险|medical|medicine|dosage|diagnosis|treatment|legal advice|lawsuit|tax|investment|finance|insurance|طبي|دواء|جرعة|تشخيص|علاج|استشارة\s*قانونية|دعوى|ضريبي|استثمار|تأمين)/i],
]);

const LOCAL_ONLY_CATEGORIES = new Set([
  "agent_quality",
  "architecture_audit",
  "bugfix",
  "code",
  "config",
  "document",
  "media",
  "runtime",
  "server",
  "ui",
]);
const RETRYABLE_RESEARCH_GAP_RE = /^(?:missing_required_evidence:external|authoritative_source_required|entity_claim_not_in_evidence|external_claim_not_in_evidence|numeric_claim_not_in_evidence|external_fact_without_source_link|source_link_not_in_evidence|entity_claim_conflicts_with_evidence)/;

// ---------------------------------------------------------------------------
// Risk tiers. The evidence gate's job is to prevent fabrication presented as
// fact — not to prevent answers. Tiers:
//   hard        — unverified content may be replaced. Reserved for genuinely
//                 high-stakes asks (the high_stakes floor, or the turn judge's
//                 stakes=high verdict). Fail-closed.
//   verify_soft — auto-verify once; on final failure deliver a BOUNDED answer
//                 (supported subset, or original + verification banner) —
//                 never zero content when any supported content exists.
//   advisory    — evidence enriches the answer but never controls rendering.
// Kill switch: LILY_EVIDENCE_RISK_TIERS=0 -> everything behaves as "hard"
// (the exact legacy behavior).
const HARD_RISK_REASONS = new Set(["high_stakes"]);

/** Accepts an externalFactPolicy ({required, reasonCodes, …}) or an
 *  evidencePolicy ({externalFact, externalFactReasonCodes, …}). */
function externalFactRiskTier(policy = null) {
  if (process.env.LILY_EVIDENCE_RISK_TIERS === "0") return "hard";
  const required = Boolean(policy?.required ?? policy?.externalFact);
  if (!required) return "advisory";
  const reasons = (policy.reasonCodes || policy.externalFactReasonCodes || []).map(String);
  if (reasons.some((code) => HARD_RISK_REASONS.has(code))) return "hard";
  return "verify_soft";
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function inactiveIntent() {
  return {
    detected: false,
    active: false,
    explicitResearch: false,
    researchProhibited: false,
    operationalRequest: false,
    reasonCodes: [],
    requiresFreshness: false,
    requiresSourceLinks: false,
    scopeClarificationRecommended: false,
    scopeClarificationRequired: false,
    scopeDisclosureRequired: false,
    verificationPlan: emptyVerificationPlan(),
  };
}

function classifyExternalFactIntent(text = "") {
  const source = typeof text === "string" ? text.trim().slice(0, 20_000) : "";
  if (!source) return inactiveIntent();

  const reasonCodes = [];
  const ranking = hasAny(source, RANKING_PATTERNS);
  const superlative = hasAny(source, SUPERLATIVE_PATTERNS);
  const hasUrl = URL_RE.test(source);
  const requestsAnswer = REQUEST_RE.test(source);
  const freshness = FRESHNESS_RE.test(source);
  const researchProhibited = RESEARCH_PROHIBITED_RE.test(source);
  const researchAllowed = RESEARCH_ALLOWED_RE.test(source) && !researchProhibited;
  const dynamicReasons = DYNAMIC_DOMAINS
    .filter(([, pattern]) => pattern.test(source))
    .map(([code]) => code);
  const verificationPlan = emptyVerificationPlan();
  const creativeOnly = CREATIVE_ONLY_RE.test(source);
  const assistantSelfRef = ASSISTANT_SELF_RE.test(source);
  const explicitResearch =
    researchAllowed || EXPLICIT_WEB_RE.test(source) ||
    (CONTEXTUAL_LOOKUP_RE.test(source) && (ranking || superlative || freshness || hasUrl || dynamicReasons.length > 0));

  if (ranking) reasonCodes.push("ranking");
  if (superlative) reasonCodes.push("superlative_comparison");
  if (explicitResearch) reasonCodes.push("explicit_web_research");
  if (hasUrl) reasonCodes.push("user_url");
  // Freshness is a request-SHAPE trigger (最新/今天/现任…), not a domain call:
  // coupled to an actual question it marks the ask as time-sensitive. False
  // positives are harmless — ordinary tiers fail open downstream. Creative
  // asks ("现在讲个笑话") and assistant-self questions ("今天能帮我做什么")
  // are exempt: a time word there is not an evidence need.
  if (freshness && requestsAnswer && !creativeOnly && !assistantSelfRef) reasonCodes.push("freshness");
  if (requestsAnswer || ranking || superlative || explicitResearch) reasonCodes.push(...dynamicReasons);

  const uniqueReasons = [...new Set(reasonCodes)];
  const operationalRequest = OPERATIONAL_ACTION_RE.test(source);
  const internalDataOnly = INTERNAL_DATA_RE.test(source) && !EXTERNAL_SCOPE_RE.test(source) && !explicitResearch;
  const hasNonRankingEvidenceNeed = uniqueReasons.some((code) => !["ranking", "superlative_comparison"].includes(code));
  if (creativeOnly && !hasNonRankingEvidenceNeed) return inactiveIntent();
  if (internalDataOnly) return inactiveIntent();

  const detected = uniqueReasons.length > 0;
  const requiresSourceLinks = uniqueReasons.some((code) =>
    [
      "ranking",
      "superlative_comparison",
      "explicit_web_research",
      "user_url",
      "freshness",
      "high_stakes",
    ].includes(code),
  );

  return {
    detected,
    active: detected,
    explicitResearch,
    researchProhibited,
    operationalRequest,
    reasonCodes: uniqueReasons,
    requiresFreshness: detected,
    requiresSourceLinks,
    scopeClarificationRecommended: false,
    scopeClarificationRequired: false,
    scopeDisclosureRequired: false,
    verificationPlan,
  };
}

function shouldActivateExternalFact(intent = inactiveIntent(), categories = []) {
  if (!intent?.detected) return false;
  const categorySet = new Set((Array.isArray(categories) ? categories : []).map((category) => String(category || "")));
  const hasLocalOnlyTask = [...categorySet].some((category) =>
    LOCAL_ONLY_CATEGORIES.has(category),
  );
  if (categorySet.has("release") && intent.operationalRequest) return false;
  if (hasLocalOnlyTask && intent.operationalRequest) return Boolean(intent.explicitResearch);
  return true;
}

function buildExternalFactPolicy(intent = inactiveIntent()) {
  const required = Boolean(intent?.active);
  const reasonCodes = required ? [...new Set(intent.reasonCodes || [])] : [];
  const verificationPlan = required
    ? normalizeVerificationPlan(intent.verificationPlan)
    : emptyVerificationPlan();
  const scopeClarificationRequired = required && Boolean(verificationPlan.clarificationRequired);
  const researchedRequirements = [
    "State the as-of date or source date for time-sensitive facts.",
    "For rankings or comparisons, name the ranking source and comparison criteria.",
    "Cite only source links that appeared in this turn's tool results or the user's supplied material.",
    "If evidence is unavailable, stale, or conflicting, say what cannot be confirmed instead of completing a plausible answer from memory.",
    ...requirementsForPlan(verificationPlan),
  ];
  return {
    required,
    reasonCodes,
    requiresFreshness: required && intent.requiresFreshness !== false,
    requiresSourceLinks: required && Boolean(intent.requiresSourceLinks),
    researchProhibited: Boolean(intent.researchProhibited),
    scopeClarificationRecommended: required && Boolean(intent.scopeClarificationRecommended),
    scopeClarificationRequired,
    scopeDisclosureRequired: required && Boolean(verificationPlan.scopeDisclosureRequired),
    verificationPlan,
    sourceAuthority: verificationPlan.sourceAuthority,
    entityEvidenceRequired: verificationPlan.entityEvidenceRequired,
    policy: required
      ? intent.researchProhibited
        ? "The user explicitly prohibited research. Do not use web/API tools and do not present current external facts or rankings as verified from memory. Use reasonable disclosed assumptions for non-blocking ambiguity; otherwise state that the requested current fact cannot be confirmed under this constraint."
        : scopeClarificationRequired
          ? "Clarify every unresolved scope dimension in the verification plan before researching toward or presenting a definitive list or classification."
          : "Verify this external factual request before answering, even if the user did not explicitly ask to search. Use websearch/webfetch, a live API, or an authoritative supplied document. For reversible information requests, choose a reasonable scope or comparison basis, state it explicitly, and mention materially different interpretations; ask only when no useful answer is possible without the user's choice."
      : "No external-fact override is required for this turn.",
    finalAnswerRequirements: required
      ? intent.researchProhibited
        ? [
            "Honor the no-research constraint: do not invoke web/API tools.",
            "Do not provide a current ranking or changing external fact as if verified from memory.",
            "Use reasonable disclosed assumptions for non-blocking ambiguity; state what cannot be confirmed under the constraint.",
          ]
        : researchedRequirements
      : [],
  };
}

function inheritExternalFactIntent(taskType, current = {}, previousSnapshot = null) {
  if (taskType !== "external_fact") return current;
  const previous = previousSnapshot?.externalFact || {};
  const constraints = (previousSnapshot?.intentContract?.constraints || []).join("\n");
  const inheritedNoResearch = Boolean(previous.researchProhibited) || RESEARCH_PROHIBITED_RE.test(constraints);
  const currentIsExplicit = Boolean(current.detected || current.explicitResearch || current.researchProhibited);
  const inheritedReasons = [...new Set([
    ...(previous.reasonCodes || []),
    ...(current.reasonCodes || []),
  ])];
  if (!inheritedReasons.length) inheritedReasons.push("inherited_external_fact");
  const verificationPlan = mergeExternalClaimPlans(
    current.verificationPlan,
    previous.verificationPlan,
  );
  return {
    ...current,
    active: true,
    detected: true,
    reasonCodes: inheritedReasons,
    requiresFreshness: true,
    requiresSourceLinks: true,
    researchProhibited: currentIsExplicit ? Boolean(current.researchProhibited) : inheritedNoResearch,
    scopeClarificationRecommended: verificationPlan.clarificationRequired,
    scopeClarificationRequired: verificationPlan.clarificationRequired,
    scopeDisclosureRequired: verificationPlan.scopeDisclosureRequired,
    verificationPlan,
    suppressedByOperationalTask: false,
  };
}

function shouldAutoVerifyExternalFact({
  policy = null,
  assessment = null,
  evidenceSummary = null,
  sideEffectFree = false,
  enabled = true,
} = {}) {
  const researchCanImprove = !evidenceSummary?.hasFreshEvidence ||
    RETRYABLE_RESEARCH_GAP_RE.test(String(assessment?.reason || ""));
  return Boolean(
    enabled &&
      policy?.required &&
      !policy?.researchProhibited &&
      !policy?.scopeClarificationRecommended &&
      researchCanImprove &&
      assessment?.ok === false &&
      assessment?.strongClaim &&
      sideEffectFree,
  );
}

function applyModelVerificationPlanCandidate(policy = null, candidate = null, { allowActivation = false } = {}) {
  if (!candidate || typeof candidate !== "object") return null;
  const activationRequested = !policy?.required && allowActivation && candidate.externalFact === true;
  if (!policy?.required && !activationRequested) return null;
  const verificationPlan = mergeModelVerificationPlan(policy?.verificationPlan, candidate);
  if (activationRequested && !verificationPlan.claimKinds.length) return null;
  return buildExternalFactPolicy({
    active: true,
    reasonCodes: [...new Set([
      ...(policy?.reasonCodes || []),
      ...(activationRequested ? ["model_external_fact"] : []),
    ])],
    requiresFreshness: activationRequested || policy?.requiresFreshness,
    requiresSourceLinks: activationRequested || policy?.requiresSourceLinks,
    researchProhibited: Boolean(policy?.researchProhibited),
    scopeClarificationRecommended:
      Boolean(policy?.scopeClarificationRecommended) || verificationPlan.clarificationRequired,
    scopeClarificationRequired: verificationPlan.clarificationRequired,
    scopeDisclosureRequired: verificationPlan.scopeDisclosureRequired,
    verificationPlan,
  });
}

function activateExternalFactPolicyFromObservation(policy = null) {
  if (policy?.required) return null;
  return buildExternalFactPolicy({
    active: true,
    reasonCodes: ["observed_external_research"],
    requiresFreshness: true,
    requiresSourceLinks: true,
    researchProhibited: Boolean(policy?.researchProhibited),
    verificationPlan: normalizeVerificationPlan({
      profileIds: ["observed_external_research"],
      claimKinds: ["external_fact"],
      entityEvidenceRequired: true,
    }),
  });
}

/**
 * Fail-CLOSED boundary (user decision 2026-07-20): only genuinely high-stakes
 * asks refuse delivery when verification fails or the judge is unavailable —
 * everything else fail-opens with a bounded, honestly-labeled answer. The
 * high_stakes floor regex (medical/legal/finance) is the ONLY domain
 * vocabulary left in the gate; the turn judge's stakes verdict may upgrade
 * but never downgrade it.
 */
function isHighStakesPolicy(policy = null, semanticVerdict = null) {
  if (semanticVerdict?.stakes === "high") return true;
  const reasons = (policy?.reasonCodes || policy?.externalFactReasonCodes || []).map(String);
  return reasons.includes("high_stakes");
}

module.exports = {
  activateExternalFactPolicyFromObservation,
  applyModelVerificationPlanCandidate,
  buildExternalFactPolicy,
  classifyExternalFactIntent,
  externalFactRiskTier,
  inheritExternalFactIntent,
  isHighStakesPolicy,
  shouldActivateExternalFact,
  shouldAutoVerifyExternalFact,
};
