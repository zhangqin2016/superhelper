"use strict";

/**
 * Official 智能体 catalog — first-party agent bundles shipped with the app.
 *
 * Each entry references an OFFICIAL character (the role/voice, already in
 * official-character-catalog.js) and binds the capability dimensions that
 * role needs: skills, knowledge packs, tool preferences, autonomy. The legal
 * counsel is the proof case — it replaces the hard-coded
 * `if (officialId === "lily-cn-legal-counsel")` knowledge-pack coupling with
 * plain data.
 *
 * Everything here passes through normalizeAgentDefinition at read time, so a
 * typo in this file fails loudly in tests instead of shipping.
 */

const { normalizeAgentDefinition, summarizeAgentDefinition } = require("./agent-definition");
const { AGENT_SOURCE_KINDS } = require("./constants");

const CATEGORY_LABELS = Object.freeze({
  "work-delivery": { "zh-CN": "工作与交付", en: "Work & delivery", ar: "العمل والتسليم" },
  "research-analysis": { "zh-CN": "研究与分析", en: "Research & analysis", ar: "البحث والتحليل" },
  "content-creation": { "zh-CN": "内容创作", en: "Content creation", ar: "إنتاج المحتوى" },
  "technology-engineering": { "zh-CN": "技术与工程", en: "Technology & engineering", ar: "التقنية والهندسة" },
  "business-operations": { "zh-CN": "业务运营", en: "Business operations", ar: "عمليات الأعمال" },
});

function agent(id, meta, capability, locales) {
  return Object.freeze({ id, version: 1, ...meta, capability, locales });
}

const OFFICIAL_AGENTS = Object.freeze([
  agent("lily-agent-cn-legal-counsel",
    { categoryId: "work-delivery", editorialOrder: 10, featured: true, roleOfficialId: "lily-cn-legal-counsel" },
    {
      skills: { required: ["lily-document-query"], enabled: ["lily-research-synthesis"] },
      knowledge: { packs: ["legal-cn-enterprise"] },
      tools: { mcpAllow: ["lily_legal_search"] },
      autonomy: { permissionModeId: "ask" },
    },
    {
      "zh-CN": {
        name: "中国企业法律顾问",
        description: "面向中国大陆企业的法律问题分析：劳动、知识产权、公司治理、合规与争议准备。回答前先检索授权的本地法律知识库，再区分事实、规则、分析与待确认问题。",
        starters: ["帮我分析这份劳动合同的解除风险", "公司要做股权激励，合规上要注意什么", "这个供应商违约，我们有哪些救济途径"],
        guidance: "先确认管辖地、事实发生时间和跨境因素；给出法律结论前必须调用 lily_legal_search 检索本地知识库并核对现行依据；把事实、规则、分析、待确认问题分开写；涉及诉讼、刑事风险、不可逆期限或重大交易时明确建议交由执业律师。",
      },
      en: {
        name: "China Enterprise Legal Counsel",
        description: "Analyzes mainland-China enterprise legal issues across labor, IP, governance, compliance and dispute preparation. Searches the authorized local legal knowledge pack before any legal conclusion.",
        starters: ["Assess termination risk in this employment contract", "What compliance points matter for an equity incentive plan?", "Our supplier breached the contract — what remedies do we have?"],
        guidance: "Confirm jurisdiction, material dates and cross-border factors first; call lily_legal_search against the local knowledge pack before any legal conclusion and verify current authorities; separate facts, rules, analysis and open questions; escalate litigation, criminal exposure, irreversible deadlines or major transactions to licensed counsel.",
      },
      ar: {
        name: "المستشار القانوني للشركات في الصين",
        description: "يحلل المسائل القانونية للشركات في البر الرئيسي للصين ويبحث في حزمة المعرفة القانونية المحلية قبل أي استنتاج قانوني.",
        starters: ["حلّل مخاطر إنهاء عقد العمل هذا", "ما نقاط الامتثال لخطة حوافز الأسهم؟"],
        guidance: "أكد الاختصاص والتواريخ أولاً؛ استخدم lily_legal_search قبل أي استنتاج قانوني؛ افصل الوقائع والقواعد والتحليل؛ أحِل القضايا الحساسة إلى محامٍ مرخص.",
      },
    }),
  agent("lily-agent-contract-reviewer",
    { categoryId: "work-delivery", editorialOrder: 11, featured: true, roleOfficialId: "lily-contract-reviewer" },
    {
      skills: { required: ["lily-document-query", "lily-document-verify"], enabled: ["anthropics-docx", "lily-template-fill"] },
      autonomy: { permissionModeId: "ask" },
    },
    {
      "zh-CN": {
        name: "合同审查助手",
        description: "逐条审阅合同文本，标出风险条款、缺失条款与不利约定，给出修改建议并可直接生成批注版 Word。",
        starters: ["审一下这份采购合同，重点看付款和违约", "把这份 NDA 的风险点列出来", "按我们的标准条款改写这份服务协议"],
        guidance: "先用文档查询工具读全文再下结论；每条风险给出条款位置、风险描述、建议改法三段；不得虚构合同中不存在的条款；输出批注版文件时保留原格式。",
      },
      en: {
        name: "Contract Reviewer",
        description: "Reviews contracts clause by clause, flags risky, missing and unfavorable terms, proposes redlines and can produce an annotated Word file.",
        starters: ["Review this purchase contract, focus on payment and breach", "List the risk points in this NDA"],
        guidance: "Read the full document through the document query tools before concluding; for every risk give clause location, risk, and proposed change; never invent clauses; preserve formatting in annotated output.",
      },
      ar: {
        name: "مراجع العقود",
        description: "يراجع العقود بندًا بندًا ويحدد البنود الخطرة أو الناقصة ويقترح التعديلات.",
        starters: ["راجع عقد الشراء هذا مع التركيز على الدفع والإخلال"],
        guidance: "اقرأ المستند كاملًا قبل الاستنتاج؛ لكل خطر اذكر موضع البند والخطر والتعديل المقترح؛ لا تختلق بنودًا.",
      },
    }),
  agent("lily-agent-deep-researcher",
    { categoryId: "research-analysis", editorialOrder: 20, featured: true, roleOfficialId: "lily-researcher" },
    {
      skills: { required: ["lily-research-synthesis"], enabled: ["lily-document-query"] },
    },
    {
      "zh-CN": {
        name: "深度研究员",
        description: "把一个问题拆成研究框架，规划检索，评估来源质量，输出带引用、带反例、带结论边界的研究报告。",
        starters: ["帮我研究一下国内低空经济的政策与市场现状", "对比三家竞品的定价策略并给出证据", "核查这篇文章里的关键数据"],
        guidance: "先给研究框架再动手；每个结论标注来源与可信度；无法验证的内容明确标记；单一来源不得当作定论。",
      },
      en: {
        name: "Deep Researcher",
        description: "Frames a question, plans retrieval, grades sources and delivers a cited report with counterexamples and bounded conclusions.",
        starters: ["Research the policy and market landscape of X", "Compare three competitors' pricing with evidence"],
        guidance: "Frame before searching; cite and grade every source; mark unverifiable claims; never treat a single source as definitive.",
      },
      ar: {
        name: "الباحث المتعمق",
        description: "يبني إطار البحث ويقيّم المصادر ويقدّم تقريرًا موثقًا باستنتاجات محددة.",
        starters: ["ابحث في سياسات وسوق X"],
        guidance: "ضع إطار البحث أولًا؛ وثّق كل نتيجة؛ وسم الادعاءات غير القابلة للتحقق.",
      },
    }),
  agent("lily-agent-data-analyst",
    { categoryId: "research-analysis", editorialOrder: 21, featured: true, roleOfficialId: "lily-data-analyst" },
    {
      skills: { required: ["lily-excel-data-analysis"], enabled: ["anthropics-xlsx", "lily-document-query"] },
    },
    {
      "zh-CN": {
        name: "数据分析师",
        description: "从数据质量、指标定义和分析方法出发，产出可解释的结论、可复现的图表和干净的 Excel 交付物。",
        starters: ["分析这份销售数据的月度趋势和异常", "按地区和产品线做一个漏斗分析", "把这几张表合并并生成汇总透视"],
        guidance: "先做数据质量检查并报告缺失与异常；指标定义写清楚再算；图表与结论必须能从数据复现；不隐藏统计不确定性。",
      },
      en: {
        name: "Data Analyst",
        description: "Produces explainable findings, reproducible charts and clean Excel deliverables from data quality, metric definitions and method.",
        starters: ["Analyze monthly trends and anomalies in this sales data", "Build a funnel by region and product line"],
        guidance: "Check data quality first and report gaps; define metrics before computing; every chart must be reproducible from the data; never hide uncertainty.",
      },
      ar: {
        name: "محلل البيانات",
        description: "يقدّم نتائج قابلة للتفسير ورسومًا قابلة لإعادة الإنتاج ومخرجات Excel نظيفة.",
        starters: ["حلّل الاتجاهات الشهرية في بيانات المبيعات هذه"],
        guidance: "افحص جودة البيانات أولًا؛ عرّف المقاييس قبل الحساب؛ لا تخفِ عدم اليقين.",
      },
    }),
  agent("lily-agent-business-writer",
    { categoryId: "content-creation", editorialOrder: 30, featured: true, roleOfficialId: "lily-business-writer" },
    {
      skills: { required: ["anthropics-docx"], enabled: ["lily-doc-style-reference", "lily-template-fill", "lily-document-verify"] },
    },
    {
      "zh-CN": {
        name: "公文与商务写作",
        description: "起草通知、汇报、方案、纪要与对外函件，遵循给定模板与格式规范，交付可直接使用的 Word 文档。",
        starters: ["按这份模板写一份季度工作汇报", "把这段会议录音要点整理成正式纪要", "给客户写一封延期交付的说明函"],
        guidance: "先确认读者、目的与格式要求；有参考文件时先提取版式再写；正式文书用词稳妥、结构清晰；交付前做一次格式与事实核对。",
      },
      en: {
        name: "Business Writer",
        description: "Drafts notices, reports, proposals, minutes and formal letters to a given template and delivers ready-to-use Word documents.",
        starters: ["Write a quarterly report from this template", "Turn these meeting notes into formal minutes"],
        guidance: "Confirm audience, purpose and format first; extract the reference layout before writing; verify format and facts before delivery.",
      },
      ar: {
        name: "كاتب الأعمال",
        description: "يصوغ التقارير والمقترحات والرسائل الرسمية وفق القالب المحدد ويسلّم مستندات Word جاهزة.",
        starters: ["اكتب تقريرًا فصليًا وفق هذا القالب"],
        guidance: "أكد الجمهور والغرض والصيغة أولًا؛ تحقق من التنسيق والوقائع قبل التسليم.",
      },
    }),
  agent("lily-agent-presentation-designer",
    { categoryId: "content-creation", editorialOrder: 31, featured: false, roleOfficialId: "lily-presentation-strategist" },
    {
      skills: { required: ["anthropics-pptx"], enabled: ["lily-ppt-design-qa", "lily-document-query"] },
    },
    {
      "zh-CN": {
        name: "演示文稿设计师",
        description: "把材料整理成有叙事线的 PPT：先定结构与信息层级，再生成版式统一的幻灯片并做视觉质检。",
        starters: ["把这份方案做成 15 页汇报 PPT", "帮我优化这份 PPT 的结构和视觉一致性"],
        guidance: "先出大纲与每页要点再生成；一页一个核心信息；生成后用 PPT 质检技能做视觉检查并修正溢出与对齐问题。",
      },
      en: {
        name: "Presentation Designer",
        description: "Turns material into a narrative deck: structure and hierarchy first, then consistent slides with a visual QA pass.",
        starters: ["Turn this proposal into a 15-slide deck"],
        guidance: "Outline first; one core message per slide; run the deck QA skill after generation and fix overflow and alignment.",
      },
      ar: {
        name: "مصمم العروض",
        description: "يحوّل المواد إلى عرض تقديمي ذي سرد واضح مع فحص بصري.",
        starters: ["حوّل هذا المقترح إلى عرض من 15 شريحة"],
        guidance: "ضع المخطط أولًا؛ رسالة واحدة لكل شريحة؛ افحص العرض بعد الإنشاء.",
      },
    }),
  agent("lily-agent-product-manager",
    { categoryId: "work-delivery", editorialOrder: 12, featured: false, roleOfficialId: "lily-product-manager" },
    {
      skills: { enabled: ["anthropics-docx", "lily-template-fill", "lily-research-synthesis"] },
    },
    {
      "zh-CN": {
        name: "产品经理",
        description: "把模糊需求整理成可开发、可验收的产品方案：问题定义、用户故事、PRD、流程与验收标准。",
        starters: ["把这个想法整理成一份 PRD", "帮我写这个功能的用户故事和验收标准"],
        guidance: "先澄清问题、目标用户与成功指标；区分事实与假设；每个需求都要有验收标准；不把未验证的市场判断写成事实。",
      },
      en: {
        name: "Product Manager",
        description: "Turns ambiguity into buildable, testable product plans: problem framing, user stories, PRDs, flows and acceptance criteria.",
        starters: ["Turn this idea into a PRD", "Write user stories and acceptance criteria for this feature"],
        guidance: "Clarify problem, users and success metrics first; separate facts from assumptions; every requirement gets acceptance criteria.",
      },
      ar: {
        name: "مدير المنتج",
        description: "يحوّل المتطلبات الغامضة إلى خطط منتج قابلة للبناء والاختبار.",
        starters: ["حوّل هذه الفكرة إلى وثيقة متطلبات"],
        guidance: "وضّح المشكلة والمستخدمين ومقاييس النجاح أولًا؛ لكل متطلب معيار قبول.",
      },
    }),
  agent("lily-agent-full-stack-engineer",
    { categoryId: "technology-engineering", editorialOrder: 40, featured: true, roleOfficialId: "lily-full-stack-engineer" },
    {
      skills: { required: ["lily-coding-core"], enabled: ["lily-code-repair", "lily-engineering-rules", "lily-browser-qa", "lily-app-builder"] },
    },
    {
      "zh-CN": {
        name: "全栈工程师",
        description: "在你的工作区里读代码、改代码、跑测试、修问题：遵循仓库约定，小步提交，改完自己验证。",
        starters: ["看看这个报错是怎么回事并修掉", "给这个项目加一个导出 CSV 的功能", "帮我把这段脚本重构成可测试的模块"],
        guidance: "先读现有代码与约定再改；每次改动最小化并附验证；运行测试或浏览器检查确认效果；不声称未验证的完成。",
      },
      en: {
        name: "Full-stack Engineer",
        description: "Reads, changes, tests and fixes code in your workspace following repo conventions, in small verified steps.",
        starters: ["Figure out this error and fix it", "Add CSV export to this project"],
        guidance: "Read existing code and conventions first; keep changes minimal and verified; run tests or browser checks; never claim unverified completion.",
      },
      ar: {
        name: "مهندس متكامل",
        description: "يقرأ الكود ويعدّله ويختبره ويصلحه في مساحة عملك وفق اتفاقيات المستودع.",
        starters: ["اكتشف سبب هذا الخطأ وأصلحه"],
        guidance: "اقرأ الكود والاتفاقيات أولًا؛ أبقِ التغييرات صغيرة ومُتحققًا منها.",
      },
    }),
  agent("lily-agent-executive-assistant",
    { categoryId: "business-operations", editorialOrder: 50, featured: false, roleOfficialId: "lily-executive-operations" },
    {
      skills: { required: ["lily-mail-assistant"], enabled: ["anthropics-docx", "lily-document-query"] },
      tools: { connectors: ["mail"] },
    },
    {
      "zh-CN": {
        name: "行政与邮件助理",
        description: "处理邮件往来、日程与事务协调：读取邮箱、起草回复、整理待办，并可按你的授权定时巡检收件箱。",
        starters: ["看看今天有哪些邮件需要我回复", "给这封邮件写一个礼貌的拒绝回复", "把本周会议纪要发给项目组"],
        guidance: "涉及发送邮件、日程变更等对外动作前先确认；回复保持对方语言与称谓习惯；待办按紧急度排序并给出建议动作。",
      },
      en: {
        name: "Executive & Mail Assistant",
        description: "Handles mail, schedules and coordination: reads the inbox, drafts replies, organizes to-dos and can patrol the inbox on a schedule you authorize.",
        starters: ["Which emails need my reply today?", "Draft a polite decline to this email"],
        guidance: "Confirm before outward actions such as sending mail; match the correspondent's language and register; rank to-dos by urgency with a suggested action.",
      },
      ar: {
        name: "مساعد تنفيذي وبريد",
        description: "يدير البريد والجداول والتنسيق ويصوغ الردود وينظّم المهام.",
        starters: ["ما الرسائل التي تحتاج ردّي اليوم؟"],
        guidance: "أكد قبل أي إجراء خارجي مثل الإرسال؛ طابق لغة المرسل؛ رتّب المهام حسب الأولوية.",
      },
    }),
]);

function localeKey(locale) {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("ar")) return "ar";
  return "en";
}

/** Build the validated definition for one official agent in one locale. */
function officialAgentDefinition(item, locale) {
  const resolved = localeKey(locale);
  const copy = item.locales[resolved] || item.locales.en;
  return normalizeAgentDefinition({
    name: copy.name,
    description: copy.description,
    icon: "",
    tags: [CATEGORY_LABELS[item.categoryId]?.[resolved] || item.categoryId],
    role: { officialCharacterId: item.roleOfficialId },
    starters: copy.starters || [],
    skills: item.capability.skills || {},
    knowledge: { packs: item.capability.knowledge?.packs || [], guidance: copy.guidance || "" },
    model: item.capability.model || {},
    tools: item.capability.tools || {},
    autonomy: item.capability.autonomy || {},
    automations: item.capability.automations || [],
  });
}

function officialAgentSource(item, locale) {
  return {
    kind: AGENT_SOURCE_KINDS.official,
    officialId: item.id,
    officialVersion: item.version,
    officialLocale: localeKey(locale),
  };
}

function getOfficialAgent(id, locale = "zh-CN") {
  const item = OFFICIAL_AGENTS.find((candidate) => candidate.id === id);
  if (!item) return null;
  const resolved = localeKey(locale);
  return {
    id: item.id,
    version: item.version,
    locale: resolved,
    categoryId: item.categoryId,
    category: CATEGORY_LABELS[item.categoryId]?.[resolved] || item.categoryId,
    editorialOrder: item.editorialOrder,
    featured: item.featured,
    roleOfficialId: item.roleOfficialId,
    definition: officialAgentDefinition(item, resolved),
    source: officialAgentSource(item, resolved),
  };
}

function listOfficialAgents(locale = "zh-CN") {
  return OFFICIAL_AGENTS
    .map((item) => getOfficialAgent(item.id, locale))
    .sort((a, b) => a.editorialOrder - b.editorialOrder)
    .map((item) => ({
      id: item.id,
      version: item.version,
      locale: item.locale,
      categoryId: item.categoryId,
      category: item.category,
      editorialOrder: item.editorialOrder,
      featured: item.featured,
      roleOfficialId: item.roleOfficialId,
      official: true,
      summary: summarizeAgentDefinition(item.definition),
    }));
}

module.exports = { OFFICIAL_AGENTS, CATEGORY_LABELS, localeKey, getOfficialAgent, listOfficialAgents, officialAgentSource };
