"use strict";

const RANKING_PATTERNS = [
  /(?:排行榜?|排名|榜单|第\s*[一二三四五六七八九十百\d]+\s*名|前\s*\d+\s*(?:名|个)?)/i,
  /\b(?:top\s*(?:\d+|ten|twenty|hundred)|rank(?:ing|ed|s)?|leaderboard)\b/i,
];

const SUPERLATIVE_PATTERNS = [
  /(?:哪个|哪些|谁|什么).{0,12}(?:产品|公司|国家|城市|学校|大学|医院|模型|手机|电脑|软件|品牌|景点|餐厅|电影|歌曲|游戏).{0,12}(?:最好|最佳|最强|最高|最低|最多|最少|最受欢迎)/i,
  /(?:最好|最佳|最强|最受欢迎).{0,20}(?:产品|公司|国家|城市|学校|大学|医院|模型|手机|电脑|软件|品牌|景点|餐厅|电影|歌曲|游戏)/i,
  /\b(?:best|most popular|highest|lowest|largest|smallest)\b.{0,32}\b(?:product|company|country|city|school|university|hospital|model|phone|computer|software|brand|restaurant|movie|game)\b/i,
];

const EXPLICIT_WEB_RE =
  /(?:联网|上网|网上查|网络搜索|browse\s+(?:the\s+)?web|search\s+(?:the\s+)?web|search\s+online|verify\s+online|check\s+online)/i;
const RESEARCH_PROHIBITED_RE =
  /(?:不要|不用|无需|禁止|不许|不可以|别)(?:联网|上网|搜索|检索|查资料|找来源)|(?:不要|不用|无需)(?:给|提供|附)(?:来源|链接|引用)|\b(?:do\s+not|don't|dont|without)\s+(?:search(?:ing)?|brows(?:e|ing)|look(?:ing)?\s+up)|\bno\s+(?:search|sources?|citations?)\b/i;
const RESEARCH_ALLOWED_RE =
  /(?:可以|允许|请|现在)(?:我|你|系统)?(?:联网|上网|搜索|检索|查资料|找来源)|\b(?:you\s+may|please|now)\s+(?:search|browse|look\s+up)|\bsearch\s+(?:the\s+)?web\s+now\b/i;
const CONTEXTUAL_LOOKUP_RE = /(?:搜索一下|查一下|查证|核实|找来源|官网查询|look\s+it\s+up|look\s+up)/i;
const URL_RE = /https?:\/\/[^\s<>"]+/i;
const FRESHNESS_RE = /(?:最新|最近|当前|现在|目前|今天|今日|实时|截至|现任|刚刚|latest|current|today|recent|real[- ]?time|right now|as of|incumbent)/i;
const REQUEST_RE =
  /[?？]|(?:什么|多少|几|谁|哪个|哪些|是否|有没有|告诉我|给我|列出|比较|查|搜索|查询|分析|解读|总结|how much|how many|who is|what is|which|show me|list|compare|find|tell me)/i;
const CREATIVE_ONLY_RE =
  /(?:写一首|写首|编一个|虚构|纯创作|小说|诗歌|故事|段子|creative writing|write (?:a|an) (?:poem|story|joke)|fictional)/i;
const OPERATIONAL_ACTION_RE =
  /(?:修复|实现|开发|创建|新建|设计|修改|改造|重构|部署|发布|上线|打包|测试|排查|调试|接入|配置|写代码|fix|implement|build|create|design|edit|refactor|deploy|publish|release|package|test|debug|integrate|configure)/i;
const INTERNAL_DATA_RE =
  /(?:我们公司|本公司|公司内部|内部数据|团队成员|员工|销售员|门店|班级|学生成绩|数据库里|表格里|文件里|这份数据|our company|internal data|our team|employees?|sales reps?|class grades?|in (?:the|this) (?:database|spreadsheet|file))/i;
const EXTERNAL_SCOPE_RE = /(?:全球|世界|全国|行业|市场|公开榜单|global|worldwide|national|industry|market|public ranking)/i;

const DYNAMIC_DOMAINS = Object.freeze([
  ["news", /(?:新闻|热搜|头条|时事|突发|news|headline|breaking)/i],
  ["price_market", /(?:价格|报价|股价|行情|汇率|利率|市值|票房|销量|油价|金价|房价|price|stock price|quote|market cap|exchange rate|interest rate|box office|sales)/i],
  ["role", /(?:ceo|cfo|cto|president|prime minister|chair(?:man|person)|mayor|governor|董事长|总裁|负责人|总统|总理|首相|部长|主席|市长|州长|现任|任职)/i],
  ["law_policy", /(?:法律|法规|政策|规定|监管|标准|条例|办法|税率|law|regulation|policy|standard|rule|tax rate)/i],
  ["release_version", /(?:版本|发布|发行|上线|更新|补丁|release|version|launch|update|patch)/i],
  ["statistics", /(?:统计|数据|比例|占比|人口|gdp|增长率|失业率|通胀率|覆盖率|statistics?|population|growth rate|unemployment|inflation|coverage rate)/i],
  ["sports_schedule", /(?:比分|赛程|积分榜|战绩|冠军|score|schedule|standings|champion)/i],
  ["weather", /(?:天气|气温|降雨|台风|weather|temperature|rainfall|typhoon)/i],
  ["high_stakes", /(?:医疗|医学|药物|剂量|诊断|治疗|法律意见|诉讼|税务|投资|理财|证券|保险|medical|medicine|dosage|diagnosis|treatment|legal advice|lawsuit|tax|investment|finance|insurance)/i],
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

const NAMED_RANKING_SOURCE_RE =
  /(?:\bqs\b|times higher education|u\.?s\.? news|fortune|forbes|软科|校友会|世界银行|国家统计局|官方榜单|按.{0,16}(?:销量|营收|市值|评分|用户数|gdp|人口|票房|下载量)|according to|ranked by)/i;

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
  const explicitResearch =
    researchAllowed || EXPLICIT_WEB_RE.test(source) ||
    (CONTEXTUAL_LOOKUP_RE.test(source) && (ranking || superlative || freshness || hasUrl || dynamicReasons.length > 0));

  if (ranking) reasonCodes.push("ranking");
  if (superlative) reasonCodes.push("superlative_comparison");
  if (explicitResearch) reasonCodes.push("explicit_web_research");
  if (hasUrl) reasonCodes.push("user_url");
  if (freshness && (dynamicReasons.length || ranking || superlative)) reasonCodes.push("freshness");
  if (requestsAnswer || ranking || superlative || explicitResearch) reasonCodes.push(...dynamicReasons);

  const uniqueReasons = [...new Set(reasonCodes)];
  const creativeOnly = CREATIVE_ONLY_RE.test(source);
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
      "news",
      "role",
      "law_policy",
      "release_version",
      "statistics",
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
    scopeClarificationRecommended: ranking && !NAMED_RANKING_SOURCE_RE.test(source),
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
  return {
    required,
    reasonCodes: required ? [...new Set(intent.reasonCodes || [])] : [],
    requiresFreshness: required && intent.requiresFreshness !== false,
    requiresSourceLinks: required && Boolean(intent.requiresSourceLinks),
    researchProhibited: required && Boolean(intent.researchProhibited),
    scopeClarificationRecommended: required && Boolean(intent.scopeClarificationRecommended),
    policy: required
      ? intent.researchProhibited
        ? "The user explicitly prohibited research. Do not use web/API tools and do not present current external facts or rankings as verified from memory. Ask one concise scope question when needed; otherwise state that the requested current fact cannot be confirmed under this constraint."
        : "Verify this external factual request before answering, even if the user did not explicitly ask to search. Use websearch/webfetch, a live API, or an authoritative supplied document. If region, time period, category, ranking source, or metric would materially change the answer, ask one concise scope question instead of silently choosing."
      : "No external-fact override is required for this turn.",
    finalAnswerRequirements: required
      ? intent.researchProhibited
        ? [
            "Honor the no-research constraint: do not invoke web/API tools.",
            "Do not provide a current ranking or changing external fact as if verified from memory.",
            "Ask one concise scope question when useful; otherwise state what cannot be confirmed under the constraint.",
          ]
        : [
            "State the as-of date or source date for time-sensitive facts.",
            "For rankings or comparisons, name the ranking source and comparison criteria.",
            "Cite only source links that appeared in this turn's tool results or the user's supplied material.",
            "If evidence is unavailable, stale, or conflicting, say what cannot be confirmed instead of completing a plausible answer from memory.",
          ]
      : [],
  };
}

function inheritExternalFactIntent(taskType, current = {}, previousSnapshot = null) {
  if (taskType !== "external_fact") return current;
  const previous = previousSnapshot?.externalFact || {};
  const constraints = (previousSnapshot?.intentContract?.constraints || []).join("\n");
  const inheritedNoResearch = Boolean(previous.researchProhibited) || RESEARCH_PROHIBITED_RE.test(constraints);
  const currentIsExplicit = Boolean(current.detected || current.explicitResearch || current.researchProhibited);
  return {
    ...current,
    active: true,
    detected: true,
    reasonCodes: current.reasonCodes?.length
      ? current.reasonCodes
      : previous.reasonCodes?.length ? previous.reasonCodes : ["inherited_external_fact"],
    requiresFreshness: true,
    requiresSourceLinks: true,
    researchProhibited: currentIsExplicit ? Boolean(current.researchProhibited) : inheritedNoResearch,
    scopeClarificationRecommended: currentIsExplicit
      ? Boolean(current.scopeClarificationRecommended)
      : Boolean(previous.scopeClarificationRecommended),
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
  return Boolean(
    enabled &&
      policy?.required &&
      !policy?.researchProhibited &&
      !policy?.scopeClarificationRecommended &&
      !evidenceSummary?.hasFreshEvidence &&
      assessment?.ok === false &&
      assessment?.strongClaim &&
      sideEffectFree,
  );
}

module.exports = {
  buildExternalFactPolicy,
  classifyExternalFactIntent,
  inheritExternalFactIntent,
  shouldActivateExternalFact,
  shouldAutoVerifyExternalFact,
};
