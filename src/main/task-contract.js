"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  PLATFORM_BASELINE_RULES,
  TASK_TYPE_SCHEMA_VERSION,
  canonicalTaskTypeFromCategories,
  modelDraftSchema,
  taskTypeDefinition,
} = require("./task-type-schema");
const {
  buildExternalFactPolicy,
  classifyExternalFactIntent,
  inheritExternalFactIntent,
  shouldActivateExternalFact,
} = require("./external-fact-policy");
const {
  buildIntentContract,
  compactIntentContract,
  findLatestTaskContractSnapshot,
  isInheritedRelation,
  relationForText,
  snapshotFromSummary,
} = require("./intent-contract");
const {
  extractExplicitNegativePhrases,
  inferContentTaskIntent,
} = require("./content-task-intent");
const { inferProgramTaskIntent } = require("./program-task-intent");
const { buildEvidencePolicy } = require("./task-evidence-policy");

const TASK_INTELLIGENCE_SCHEMA_VERSION = 1;
const TASK_INTELLIGENCE_MAX_LIST_ITEMS = 256;
const TASK_INTELLIGENCE_MAX_STRING_LENGTH = 500;
const TASK_INTELLIGENCE_MAX_PROFILES = 64;
const TASK_INTELLIGENCE_MAX_CATEGORIES = 64;

const DEFAULT_TASK_INTELLIGENCE_REGISTRY = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  fileExtensions: [
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".css",
    ".go",
    ".html",
    ".java",
    ".js",
    ".jsx",
    ".json",
    ".kt",
    ".mjs",
    ".py",
    ".rb",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
  ],
  priority: ["external_fact", "release", "runtime", "architecture_audit", "agent_quality", "server", "ui", "config", "code", "content_extraction", "document", "media", "bugfix"],
  activatingCategories: ["bugfix", "ui", "server", "release", "runtime", "architecture_audit", "agent_quality", "config", "code", "external_fact"],
  lowInformationContinuation: {
    terms: ["继续", "接着", "然后", "展开", "继续说", "继续讲", "continue", "go on", "next"],
    genericObjects: [
      "这个",
      "这",
      "上面",
      "刚才",
      "流程",
      "实现",
      "任务",
      "执行",
      "方案",
      "问题",
      "it",
      "this",
      "that",
      "task",
      "flow",
      "process",
      "implementation",
    ],
  },
  categories: {
    external_fact: {
      terms: [],
      weakTerms: [],
    },
    architecture_audit: {
      terms: [
        "architecture audit",
        "system audit",
        "system weakness",
        "weak point",
        "weakness",
        "bottleneck",
        "系统审视",
        "架构审视",
        "架构诊断",
        "系统诊断",
        "系统分析",
        "笨的地方",
        "比较笨",
        "哪里笨",
        "不聪明",
        "不够聪明",
        "顶级设计",
        "顶级系统",
        "未完成",
        "所有未完成",
        "全部未完成",
        "不忘初心",
      ],
      weakTerms: ["系统分析"],
    },
    agent_quality: {
      terms: [
        "agent",
        "assistant",
        "intent",
        "routing",
        "router",
        "prompt",
        "小模型",
        "大智慧",
        "变笨",
        "聪明",
        "智能",
        "意图",
        "路由",
        "识别",
        "准确",
        "一次通过",
        "闭环",
        "智能度",
        "系统智能",
        "更聪明",
        "补齐",
        "最终形态",
        "全部推进",
        "大步推进",
      ],
      weakTerms: ["识别", "准确", "原因"],
    },
    bugfix: {
      terms: [
        "bug",
        "error",
        "failed",
        "failure",
        "fix",
        "repair",
        "卡",
        "卡住",
        "失败",
        "报错",
        "打不开",
        "没反应",
        "不生效",
        "重复",
        "修复",
        "原因",
        "根因",
        "异常",
        "404",
        "401",
        "timeout",
      ],
      weakTerms: ["原因"],
    },
    ui: {
      terms: [
        "ui",
        "ux",
        "css",
        "style",
        "layout",
        "renderer",
        "页面",
        "布局",
        "样式",
        "颜色",
        "交互",
        "按钮",
        "弹窗",
        "渲染",
        "前端",
        "官网",
        "后台",
      ],
      weakTerms: ["后台"],
    },
    server: {
      terms: [
        "api",
        "server",
        "backend",
        "database",
        "postgres",
        "migration",
        "docker",
        "服务端",
        "接口",
        "数据库",
        "后台",
        "管理后台",
        "登录",
        "鉴权",
        "统计",
      ],
      weakTerms: ["后台", "登录"],
    },
    release: {
      terms: [
        "release",
        "publish",
        "deploy",
        "dist",
        "installer",
        "version",
        "qiniu",
        "docker",
        "打包",
        "发布",
        "部署",
        "推送",
        "安装包",
        "版本",
        "更新",
        "七牛",
        "宝塔",
      ],
    },
    runtime: {
      terms: [
        "claude",
        "cli",
        "runtime",
        "stream",
        "event",
        "turn",
        "tool",
        "permission",
        "session",
        "queue",
        "会话",
        "队列",
        "权限",
        "事件",
        "工具",
        "连接中",
        "任务",
        "执行中",
      ],
      weakTerms: ["任务"],
    },
    config: {
      terms: [
        "config",
        "preset",
        "model",
        "apikey",
        "api key",
        "gateway",
        "配置",
        "下发",
        "模型",
        "密钥",
        "网关",
        "直连",
      ],
    },
    code: {
      terms: [
        "code",
        "script",
        "test",
        "npm",
        "implement",
        "refactor",
        "commit",
        "flow",
        "architecture",
        "代码",
        "脚本",
        "实现",
        "测试",
        "提交",
        "函数",
        "组件",
        "模块",
        "源码",
        "流程",
        "流转",
        "架构",
      ],
    },
    document: {
      terms: ["docx", "pdf", "ppt", "pptx", "excel", "xlsx", "word", "文档", "表格", "报告", "简历", "合同"],
    },
    media: {
      terms: ["image", "video", "audio", "voice", "图片", "视频", "语音", "截图", "生成图"],
    },
  },
  workspaceSignals: [
    {
      id: "node",
      markerFiles: ["package.json"],
      hints: ["Package scripts: package.json", "Source tree: src/", "Tests: test/ or tests/"],
    },
    {
      id: "electron",
      markerFiles: ["src/main.js", "src/preload.js", "src/main", "src/renderer"],
      hints: ["Desktop main process: src/main/ or src/main.js", "Renderer UI: src/renderer/", "Preload bridge: src/preload.js"],
    },
    {
      id: "server",
      markerFiles: ["server/src", "server/package.json", "src/server", "api"],
      hints: ["Server/API surface: server/src/ or src/server/", "Server tests and migrations should be checked when present."],
    },
    {
      id: "web",
      markerFiles: ["web", "app", "pages", "src/app"],
      hints: ["Web/admin surface: web/, app/, pages/, or src/app/"],
    },
    {
      id: "java",
      markerFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
      hints: ["Java sources: src/main/java/", "Java tests: src/test/java/"],
    },
    {
      id: "python",
      markerFiles: ["pyproject.toml", "requirements.txt"],
      hints: ["Python package/config: pyproject.toml or requirements.txt", "Python tests: tests/"],
    },
  ],
  workspaceProfiles: [],
  verificationStrategies: {},
  checklists: {
    base: [
      "Find the real entry point and immediate callers before editing.",
      "Check adjacent tests/fixtures/docs that encode the same behavior.",
      "Keep changes proportional to the request; avoid opportunistic refactors.",
    ],
    byCategory: {
      runtime: [
        "For protocol/runtime work, preserve event ordering, turn ownership, queue semantics, and permission prompts.",
        "Add or update a fixture/regression test when a new runtime event shape is handled.",
      ],
      agent_quality: [
        "For agent-quality work, inspect model tier selection, prompt/guidance injection, deterministic intent routing, skill/tool boundaries, and final-output synchronization.",
        "Prefer platform-side classifiers, guards, schemas, and regression fixtures over asking the model to remember long prose rules.",
      ],
      architecture_audit: [
        "For architecture audits, identify impact surfaces before conclusions and ground each weakness in source, runtime, document, or product evidence.",
        "Preserve the natural-language workbench stance: prefer agent-invocable contracts, skills, scripts, and evidence over new primary UI panels.",
      ],
      ui: ["For UI work, verify the visible state, empty/loading/error states, and repeated interaction path."],
      server: ["For server work, verify auth boundaries, persistence, migrations, and public/admin route differences."],
      release: ["For release/deploy work, verify artifact names, update manifest, upload target, and live version after publish."],
      config: ["For config/model work, separate local override, server-managed config, secret handling, and inactive-device update access."],
      document: ["For document work, verify page coverage, OCR needs, tables/images, output format, and whether the output opens."],
      media: ["For media work, keep generation progress visible and provide a preview or directly openable path."],
      external_fact: [
        "For external facts, search or query a live/authoritative source before answering and preserve source links, dates, and comparison criteria.",
      ],
    },
  },
});

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value
        .slice(0, TASK_INTELLIGENCE_MAX_LIST_ITEMS)
        .map((item) => String(item || "").trim().slice(0, TASK_INTELLIGENCE_MAX_STRING_LENGTH))
        .filter(Boolean)
    : null;
}

function uniqueStrings(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of arrayOfStrings(list) || []) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function nonEmptyStrings(value) {
  const list = arrayOfStrings(value);
  return list && list.length ? list : null;
}

function remoteTaskIntelligenceConfig() {
  try {
    const config = require("./remote-config").getRemoteEffectiveConfigSync();
    return config?.taskIntelligence && typeof config.taskIntelligence === "object"
      ? config.taskIntelligence
      : null;
  } catch {
    return null;
  }
}

function mergeWorkspaceProfiles(baseProfiles, remoteProfiles) {
  const byId = new Map();
  for (const profile of Array.isArray(baseProfiles) ? baseProfiles : []) {
    if (!profile?.id) continue;
    byId.set(String(profile.id), { ...profile });
  }
  for (const profile of Array.isArray(remoteProfiles)
    ? remoteProfiles.slice(0, TASK_INTELLIGENCE_MAX_PROFILES)
    : []) {
    if (!profile?.id) continue;
    const id = String(profile.id);
    const prev = byId.get(id) || {};
    byId.set(id, {
      ...prev,
      ...profile,
      markerFiles: uniqueStrings(prev.markerFiles, profile.markerFiles),
      hints: uniqueStrings(prev.hints, profile.hints),
    });
  }
  return [...byId.values()];
}

function mergeVerificationStrategies(base = {}, remote = {}) {
  const out = {};
  const ids = new Set([...Object.keys(base || {}), ...Object.keys(remote || {})]);
  for (const id of ids) {
    out[id] = uniqueStrings(base?.[id], remote?.[id]);
  }
  return out;
}

function mergeTaskIntelligenceRegistry(base = DEFAULT_TASK_INTELLIGENCE_REGISTRY, remote = null) {
  const remoteCandidate = remote && typeof remote === "object" && !Array.isArray(remote) ? remote : {};
  const remoteSchemaVersion = Number(remoteCandidate.schemaVersion || TASK_INTELLIGENCE_SCHEMA_VERSION);
  const remoteEnhancementsEnabled =
    remoteCandidate.enabled !== false && remoteSchemaVersion === TASK_INTELLIGENCE_SCHEMA_VERSION;
  // Server delivery may extend the local intelligence registry, but it can
  // never disable or replace the client baseline. Invalid/disabled overlays
  // therefore collapse to an empty additive layer.
  const normalizedRemote = remoteEnhancementsEnabled ? remoteCandidate : {};
  const categories = {};
  const categoryIds = [...new Set([
    ...Object.keys(base.categories || {}),
    ...Object.keys(normalizedRemote.categories || {}),
  ])].slice(0, TASK_INTELLIGENCE_MAX_CATEGORIES);
  for (const categoryId of categoryIds) {
    const baseCategory = base.categories?.[categoryId] || {};
    const remoteCategory = normalizedRemote.categories?.[categoryId] || {};
    categories[categoryId] = {
      ...baseCategory,
      ...remoteCategory,
      terms: uniqueStrings(baseCategory.terms, remoteCategory.terms),
      weakTerms: uniqueStrings(baseCategory.weakTerms, remoteCategory.weakTerms),
    };
  }

  const baseChecklists = base.checklists || {};
  const remoteChecklists = normalizedRemote.checklists || {};
  const byCategory = {};
  const checklistIds = new Set([
    ...Object.keys(baseChecklists.byCategory || {}),
    ...Object.keys(remoteChecklists.byCategory || {}),
  ]);
  for (const categoryId of checklistIds) {
    byCategory[categoryId] = uniqueStrings(
      baseChecklists.byCategory?.[categoryId],
      remoteChecklists.byCategory?.[categoryId],
    );
  }

  return {
    schemaVersion: 1,
    enabled: base.enabled !== false,
    remoteEnhancementsEnabled,
    fileExtensions: uniqueStrings(base.fileExtensions, normalizedRemote.fileExtensions),
    priority: nonEmptyStrings(normalizedRemote.priority) || arrayOfStrings(base.priority) || [],
    activatingCategories:
      nonEmptyStrings(normalizedRemote.activatingCategories) || arrayOfStrings(base.activatingCategories) || [],
    categories,
    workspaceSignals: mergeWorkspaceProfiles(base.workspaceSignals, normalizedRemote.workspaceSignals),
    workspaceProfiles: mergeWorkspaceProfiles(base.workspaceProfiles, normalizedRemote.workspaceProfiles),
    verificationStrategies: mergeVerificationStrategies(base.verificationStrategies, normalizedRemote.verificationStrategies),
    lowInformationContinuation: {
      terms: uniqueStrings(
        base.lowInformationContinuation?.terms,
        normalizedRemote.lowInformationContinuation?.terms,
      ),
      genericObjects: uniqueStrings(
        base.lowInformationContinuation?.genericObjects,
        normalizedRemote.lowInformationContinuation?.genericObjects,
      ),
    },
    checklists: {
      base: uniqueStrings(baseChecklists.base, remoteChecklists.base),
      byCategory,
    },
    remoteVersion: normalizedRemote.version || normalizedRemote.configVersion || "",
  };
}

function loadTaskIntelligenceRegistry() {
  return mergeTaskIntelligenceRegistry(DEFAULT_TASK_INTELLIGENCE_REGISTRY, remoteTaskIntelligenceConfig());
}

function lowerText(value) {
  return String(value || "").toLowerCase();
}

function normalizeClassifierTerm(term = "") {
  return String(term || "").toLowerCase().replace(/\s+/g, "");
}

function isLowInformationContinuation(text = "", registry = loadTaskIntelligenceRegistry()) {
  const source = lowerText(text).replace(/[，。！？!?.,;；:\s]/g, "");
  if (!source) return false;
  const continuation = registry.lowInformationContinuation || {};
  const terms = arrayOfStrings(continuation.terms) || [];
  const genericObjects = arrayOfStrings(continuation.genericObjects) || [];
  if (!terms.length || !terms.some((term) => source.includes(normalizeClassifierTerm(term)))) {
    return false;
  }
  let remainder = source;
  for (const term of [...terms, ...genericObjects]) {
    const normalized = normalizeClassifierTerm(term);
    if (normalized) remainder = remainder.split(normalized).join("");
  }
  return remainder.length === 0;
}

function includesAny(haystack, terms) {
  return (arrayOfStrings(terms) || []).some((term) => haystack.includes(term.toLowerCase()));
}

function matchedTerms(haystack, terms) {
  return (arrayOfStrings(terms) || []).filter((term) => haystack.includes(term.toLowerCase()));
}

function categoryMatches(haystack, config = {}) {
  const terms = arrayOfStrings(config.terms) || [];
  const weak = new Set((arrayOfStrings(config.weakTerms) || []).map((term) => term.toLowerCase()));
  const strongTerms = terms.filter((term) => !weak.has(term.toLowerCase()));
  if (includesAny(haystack, strongTerms)) return true;

  // Weak terms are deliberately common words, e.g. "任务", "识别", "原因".
  // A single weak hit must not inject a runtime/agent-quality contract into an
  // ordinary request. Two weak signals are enough to preserve intentional use.
  const weakTerms = terms.filter((term) => weak.has(term.toLowerCase()));
  return matchedTerms(haystack, weakTerms).length >= 2;
}

function hasScheduledTaskNegationSafe(text) {
  try {
    return require("./schedule-parser").hasScheduledTaskNegation(text);
  } catch {
    return false;
  }
}

function redactNegatedScheduledTaskTerms(text) {
  if (!hasScheduledTaskNegationSafe(text)) return String(text || "");
  return String(text || "")
    .replace(/(?:定时|自动执行|计划任务|任务|提醒|日程|闹钟)/g, " ")
    .replace(/\b(?:schedule|scheduled task|reminder|automation)\b/gi, " ");
}

function extractNegativeConstraints(text = "") {
  const source = String(text || "").trim();
  if (!source) return [];
  const constraints = [];
  if (hasScheduledTaskNegationSafe(source)) {
    constraints.push({
      intent: "scheduled_task_creation",
      rule: "Do not create, modify, or route this request as a scheduled task.",
      evidence: "explicit scheduled-task negation in user request",
    });
  }
  for (const value of extractExplicitNegativePhrases(source)) {
    constraints.push({
      intent: "user_negative_constraint",
      rule: `Preserve this negative constraint exactly: ${value}`,
      evidence: value,
    });
  }
  const seen = new Set();
  return constraints.filter((constraint) => {
    const key = `${constraint.intent}\0${constraint.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function attachedCodeFiles(files = [], registry = loadTaskIntelligenceRegistry()) {
  const codeExtensions = new Set(arrayOfStrings(registry.fileExtensions) || []);
  return files.some((file) => {
    const name = file?.name || file?.path || file?.fileName || "";
    return codeExtensions.has(path.extname(String(name)).toLowerCase());
  });
}

function isCodebaseTechnicalTerm(term = "") {
  const lower = String(term || "").toLowerCase();
  return (
    new Set(["im", "imsdk"]).has(lower) ||
    /(?:sdk|api|cli|service|server|client|gateway|runtime|router|engine)$/i.test(lower)
  );
}

function hasCodebaseInquiry(text = "") {
  const source = String(text || "").toLowerCase();
  return /分析|流转|流程|链路|源码|模块|入口|调用|实现|架构|是什么|怎么|如何|why|how|where|architecture|source|call\s*flow|data\s*flow/.test(source);
}

function classifyTask({ text = "", files = [], registry = loadTaskIntelligenceRegistry() } = {}) {
  if (registry.enabled === false) {
    return {
      active: false,
      kind: "general",
      taskType: "general",
      categories: [],
    };
  }
  if (isLowInformationContinuation(text, registry) && !files?.length) {
    return {
      active: false,
      kind: "general",
      taskType: "general",
      categories: [],
    };
  }
  const haystack = lowerText(redactNegatedScheduledTaskTerms(text));
  const categories = [];
  for (const [category, config] of Object.entries(registry.categories || {})) {
    if (categoryMatches(haystack, config || {})) categories.push(category);
  }
  const explicitTerms = extractExplicitUserTerms(text);
  if (
    !categories.includes("code") &&
    hasCodebaseInquiry(text) &&
    explicitTerms.some((term) => isCodebaseTechnicalTerm(term))
  ) {
    categories.push("code");
  }
  if (attachedCodeFiles(files, registry) && !categories.includes("code")) categories.push("code");

  const contentIntent = inferContentTaskIntent({ text, files });
  const programIntent = inferProgramTaskIntent({ text, files });
  if (programIntent.routeTaskType === "code_change" && !categories.includes("code")) categories.push("code");
  const routedCategory = contentIntent.routeTaskType === "content_extraction"
    ? "content_extraction"
    : contentIntent.routeTaskType === "media_generation"
      ? "media"
      : contentIntent.routeTaskType === "document_work"
        ? "document"
        : "";
  if (routedCategory && !categories.includes(routedCategory)) categories.push(routedCategory);

  const detectedExternalFact = classifyExternalFactIntent(text);
  const registryExternalFact = categories.includes("external_fact");
  const activateExternalFact = registryExternalFact || shouldActivateExternalFact(detectedExternalFact, categories);
  if (activateExternalFact && !categories.includes("external_fact")) categories.push("external_fact");
  const externalFactIntent = {
    ...detectedExternalFact,
    active: activateExternalFact,
    detected: Boolean(detectedExternalFact.detected || registryExternalFact),
    reasonCodes: detectedExternalFact.reasonCodes?.length
      ? detectedExternalFact.reasonCodes
      : registryExternalFact
        ? ["registry_external_fact"]
        : [],
    requiresFreshness: activateExternalFact
      ? registryExternalFact && !detectedExternalFact.detected
        ? true
        : detectedExternalFact.requiresFreshness !== false
      : false,
    requiresSourceLinks: activateExternalFact
      ? registryExternalFact && !detectedExternalFact.detected
        ? true
        : detectedExternalFact.requiresSourceLinks !== false
      : false,
    suppressedByOperationalTask: Boolean(detectedExternalFact.detected && !activateExternalFact),
  };

  const activatingCategories = new Set(arrayOfStrings(registry.activatingCategories) || []);
  const taskType = canonicalTaskTypeFromCategories(categories);
  const semanticIntent = taskType === "code_change" && programIntent.active
    ? programIntent
    : contentIntent.active
      ? { domain: "content", ...contentIntent }
      : null;
  const definition = taskTypeDefinition(taskType);
  const active = categories.some((category) => activatingCategories.has(category)) || Boolean(definition.active);
  const kind = taskType === "content_extraction"
    ? "content_extraction"
    : (arrayOfStrings(registry.priority) || []).find((category) => categories.includes(category)) || "general";
  return {
    active,
    kind,
    taskType,
    categories,
    contentIntent,
    programIntent,
    semanticIntent,
    externalFactIntent,
  };
}

function exists(projectPath, relativePath) {
  try {
    return Boolean(projectPath) && fs.existsSync(path.join(projectPath, relativePath));
  } catch {
    return false;
  }
}

function profileMatches(projectPath, profile) {
  if (!profile || !projectPath) return false;
  return (arrayOfStrings(profile.markerFiles) || []).some((marker) => exists(projectPath, marker));
}

function resolvedProfileHints(projectPath, profile) {
  const hints = uniqueStrings(profile?.hints || []);
  if (profile?.id === "node") {
    if (exists(projectPath, "src")) hints.push("Source tree: src/");
    if (exists(projectPath, "test")) hints.push("Tests: test/");
    if (exists(projectPath, "tests")) hints.push("Tests: tests/");
  }
  if (profile?.id === "python" && exists(projectPath, "tests")) hints.push("Python tests: tests/");
  return uniqueStrings(hints);
}

function workspaceTypeFromSignals(signals) {
  const ids = new Set(signals.map((signal) => signal.id));
  if (ids.has("electron") && ids.has("server") && ids.has("web")) return "desktop-fullstack";
  if (ids.has("electron")) return "desktop-app";
  if (ids.has("server") && ids.has("web")) return "web-fullstack";
  if (ids.has("server")) return "server";
  if (ids.has("web")) return "web";
  if (ids.has("java")) return "java";
  if (ids.has("python")) return "python";
  if (ids.has("node")) return "node";
  if (signals.length === 1 && signals[0]?.id) return signals[0].id;
  return "generic";
}

function detectWorkspaceProfile(projectPath, registry = loadTaskIntelligenceRegistry()) {
  if (!projectPath) return { type: "unknown", hints: [] };
  const signals = [];
  for (const profile of [...(registry.workspaceSignals || []), ...(registry.workspaceProfiles || [])]) {
    if (!profileMatches(projectPath, profile)) continue;
    signals.push({
      id: String(profile.id || "generic"),
      hints: resolvedProfileHints(projectPath, profile),
    });
  }
  if (signals.length) {
    return {
      type: workspaceTypeFromSignals(signals),
      signals: signals.map((signal) => signal.id),
      hints: uniqueStrings(...signals.map((signal) => signal.hints)),
    };
  }
  return { type: "generic", signals: [], hints: [] };
}

const WORKSPACE_OPERATION_CATEGORIES = new Set([
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

function isPureExternalFactClassification(classification = {}) {
  if (!classification.externalFactIntent?.active || classification.externalFactIntent?.operationalRequest) return false;
  return !(classification.categories || []).some((category) => WORKSPACE_OPERATION_CATEGORIES.has(category));
}

function buildImpactChecklist(classification, profile, registry = loadTaskIntelligenceRegistry()) {
  const checklists = registry.checklists || {};
  const checklist = isPureExternalFactClassification(classification) ? [] : uniqueStrings(checklists.base);
  for (const category of classification.categories || []) {
    checklist.push(...(arrayOfStrings(checklists.byCategory?.[category]) || []));
  }
  if (profile.hints.length) {
    checklist.push(`Workspace impact hints: ${profile.hints.join("; ")}.`);
  }
  return uniqueStrings(checklist);
}

function buildVerificationStrategy(classification, registry = loadTaskIntelligenceRegistry()) {
  const definition = taskTypeDefinition(classification.taskType);
  return uniqueStrings(
    definition.verification || [],
    registry.verificationStrategies?.[classification.taskType],
  );
}

const GREENFIELD_TERMS = Object.freeze([
  "全新",
  "从零",
  "新建一个应用",
  "新建应用",
  "新的应用",
  "单独创建一个应用",
  "独立应用",
  "新项目",
  "创建项目",
  "greenfield",
  "new app",
  "new project",
  "from scratch",
]);

const USER_TERM_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "what",
  "why",
  "how",
  "code",
  "test",
  "file",
  "node",
]);

function extractExplicitUserTerms(text = "") {
  const source = String(text || "");
  const terms = [];
  const seen = new Set();
  const matches = source.match(/[A-Za-z][A-Za-z0-9_-]{1,40}/g) || [];
  for (const raw of matches) {
    const term = raw.trim();
    const lower = term.toLowerCase();
    const exactTechnicalAcronym = new Set(["im", "cst", "imsdk"]).has(lower);
    const technical =
      term.length >= 4 ||
      /[0-9_-]/.test(term) ||
      /^[A-Z]{2,}$/.test(term) ||
      /(?:sdk|api|cli|http|tcp|ws)$/i.test(term) ||
      exactTechnicalAcronym;
    if (!technical || USER_TERM_STOPWORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    terms.push(term);
    if (terms.length >= 8) break;
  }
  return terms;
}

function buildSourceCoveragePolicy({ text = "", classification = {} } = {}) {
  const terms = extractExplicitUserTerms(text);
  const required = Boolean(
    classification.active &&
      !isPureExternalFactClassification(classification) &&
      (terms.length || classification.taskType === "architecture_audit"),
  );
  return {
    required,
    explicitTerms: terms,
    policy: required
      ? classification.taskType === "architecture_audit" && !terms.length
        ? "Before making architecture or system-quality claims, inspect representative workspace structure and source files. Do not rely only on memory or product intuition."
        : "Before making codebase or architecture claims, search for the user's explicit terms in paths, filenames, symbols, docs, and fixtures. Do not substitute a neighboring subsystem or acronym unless evidence proves it is part of the requested scope."
      : "No explicit source term coverage required.",
  };
}

function hasGreenfieldIntent(text = "") {
  const source = lowerText(text);
  return GREENFIELD_TERMS.some((term) => source.includes(term.toLowerCase()));
}

function buildWorkspaceGroundingPolicy({ text = "", classification = {}, profile = { type: "unknown", signals: [] } } = {}) {
  const active = Boolean(classification.active);
  const categories = new Set(classification.categories || []);
  const needsGrounding =
    active &&
    !isPureExternalFactClassification(classification) &&
    (
      ["code", "ui", "server", "runtime", "config", "bugfix", "agent_quality", "release"].some((category) =>
        categories.has(category),
      ) ||
      categories.has("architecture_audit")
    );
  const greenfieldAllowed = hasGreenfieldIntent(text);
  return {
    required: needsGrounding,
    mode: greenfieldAllowed ? "greenfield_allowed" : "reuse_existing_workspace",
    allowNewTopLevel: greenfieldAllowed,
    workspaceProfile: profile.type || "unknown",
    requiredEvidence: needsGrounding
      ? uniqueStrings([
          "workspace_tree_or_manifest",
          "existing_entrypoint_or_target_directory",
          "similar_implementation_or_call_site",
        ])
      : [],
    policy: needsGrounding
      ? greenfieldAllowed
        ? "A new top-level app/project is allowed because the user explicitly asked for a greenfield build. Still inspect the current workspace first and avoid duplicating an existing suitable surface."
        : "Default to improving the current workspace. Before creating a new top-level directory, standalone app, or parallel implementation, inspect existing structure and either reuse a suitable target or ask the user for confirmation."
      : "No strict workspace grounding required for this turn.",
  };
}

function buildLocalDraft({ text, classification, profile, verificationStrategy, intentContract }) {
  return {
    schemaVersion: TASK_TYPE_SCHEMA_VERSION,
    taskType: classification.taskType,
    operation: classification.semanticIntent?.operation || "unknown",
    sourceKinds: classification.semanticIntent?.sourceKinds || [],
    outputMode: classification.semanticIntent?.outputMode || "unknown",
    relation: intentContract?.relation || "new",
    objective: intentContract?.objective || String(text || "").trim().slice(0, 500),
    currentInstruction: intentContract?.currentInstruction || String(text || "").trim().slice(0, 500),
    deliverables: intentContract?.deliverables || [],
    successCriteria: intentContract?.successCriteria || verificationStrategy,
    impactSurface: profile.hints || [],
    assumptions: intentContract?.assumptions || [],
    criticalUnknowns: intentContract?.criticalUnknowns || [],
    neededCapabilities: intentContract?.neededCapabilities || classification.categories || [],
    risks: [],
    verificationPlan: verificationStrategy,
  };
}

function buildTaskContract({
  text = "",
  files = [],
  session = null,
  project = null,
  messages = null,
  previousIntentContract = null,
} = {}) {
  const registry = loadTaskIntelligenceRegistry();
  const history = Array.isArray(messages) ? messages : Array.isArray(session?.messages) ? session.messages : [];
  const historySnapshot = findLatestTaskContractSnapshot(history);
  const historyHasAssistantTurn = history.some((message) => message?.role === "assistant");
  const previousSnapshot = historySnapshot || (!historyHasAssistantTurn ? snapshotFromSummary(previousIntentContract) : null);
  const relation = relationForText(text, Boolean(previousSnapshot));
  let classification = classifyTask({ text, files, registry });
  if (!classification.active && previousSnapshot?.active && isInheritedRelation(relation)) {
    classification = {
      ...classification,
      active: true,
      kind: previousSnapshot.kind || "operational",
      taskType: previousSnapshot.taskType,
      categories: previousSnapshot.categories || [],
      contentIntent: previousSnapshot.contentIntent || classification.contentIntent,
      programIntent: previousSnapshot.programIntent || classification.programIntent,
      semanticIntent: previousSnapshot.semanticIntent || classification.semanticIntent,
      externalFactIntent: inheritExternalFactIntent(
        previousSnapshot.taskType,
        classification.externalFactIntent,
        previousSnapshot,
      ),
    };
  }
  if (
    classification.taskType === "external_fact" &&
    previousSnapshot?.taskType === "external_fact" &&
    isInheritedRelation(relation)
  ) {
    classification.externalFactIntent = inheritExternalFactIntent(
      "external_fact",
      classification.externalFactIntent,
      previousSnapshot,
    );
  }
  const externalFactPolicy = buildExternalFactPolicy(classification.externalFactIntent);
  const priorSourceContentEvidence = isInheritedRelation(relation)
    ? previousSnapshot?.sourceContentEvidence || null
    : null;
  const negativeConstraints = extractNegativeConstraints(text);
  const verificationStrategy = buildVerificationStrategy(classification, registry);
  const intentContract = buildIntentContract({
    text,
    taskType: classification.taskType,
    categories: classification.categories,
    verificationStrategy,
    negativeConstraints,
    previousSnapshot,
  });
  if (!classification.active) {
    return {
      active: false,
      kind: classification.kind,
      taskType: classification.taskType,
      categories: classification.categories,
      negativeConstraints,
      externalFactPolicy,
      contentIntent: classification.contentIntent || null,
      programIntent: classification.programIntent || null,
      semanticIntent: classification.semanticIntent || null,
      priorSourceContentEvidence,
      evidencePolicy: buildEvidencePolicy(classification),
      sourceCoveragePolicy: buildSourceCoveragePolicy({ text, classification }),
      intentContract,
      workspaceGroundingPolicy: buildWorkspaceGroundingPolicy({
        text,
        classification,
        profile: { type: "unknown", signals: [] },
      }),
    };
  }
  const projectPath = project?.path || session?.workspacePath || "";
  const profile = isPureExternalFactClassification(classification)
    ? { type: "external-research", signals: [], hints: [] }
    : detectWorkspaceProfile(projectPath, registry);
  const checklist = buildImpactChecklist(classification, profile, registry);
  return {
    active: true,
    schemaVersion: TASK_TYPE_SCHEMA_VERSION,
    kind: classification.kind,
    taskType: classification.taskType,
    categories: classification.categories,
    projectPath,
    workspaceProfile: profile.type,
    workspaceSignals: profile.signals || [],
    registryVersion: registry.remoteVersion || "local-default",
    platformRules: PLATFORM_BASELINE_RULES,
    negativeConstraints,
    blockedIntents: negativeConstraints
      .filter((item) => item.intent && item.intent !== "user_negative_constraint")
      .map((item) => item.intent),
    externalFactPolicy,
    contentIntent: classification.contentIntent || null,
    programIntent: classification.programIntent || null,
    semanticIntent: classification.semanticIntent || null,
    priorSourceContentEvidence,
    evidencePolicy: buildEvidencePolicy(classification),
    sourceCoveragePolicy: buildSourceCoveragePolicy({ text, classification }),
    workspaceGroundingPolicy: buildWorkspaceGroundingPolicy({ text, classification, profile }),
    intentContract,
    checklist,
    verificationStrategy,
    modelDraft: {
      requested: true,
      schema: modelDraftSchema(),
      localFallback: buildLocalDraft({ text, classification, profile, verificationStrategy, intentContract }),
    },
  };
}

function withTaskContractPrefix(text, contract) {
  if (!contract?.active) return String(text || "");
  const { addLayersToEngineText } = require("./engine-message-layers");
  const intentRelation = contract.intentContract?.relation || "new";
  const newTaskIsolation = intentRelation === "new"
    ? [
        "",
        "New-task isolation boundary:",
        "This is a separate task, not a continuation of a completed or in-progress earlier task.",
        "Prior conversation is background only. Do not reuse or modify prior task-specific artifacts, output directories, generated datasets, plans, TODOs, tool runs, or conclusions unless the current user instruction explicitly names or attaches them.",
        "You may inspect the workspace to identify the real target, but never select an earlier task's directory merely because it already contains useful-looking files. Before the first side effect, establish the target and output scope from the current request.",
        "When the current request does not identify a target and the workspace contains multiple unrelated workstreams, keep the new work independently named and avoid overwriting an existing deliverable; ask only if a safe independent scope cannot be chosen.",
      ]
    : [];
  const contractText = [
    "<lily_task_contract>",
    "This internal contract improves execution quality. Do not quote it back unless the user asks about process.",
    "The user's original request remains the highest-priority instruction, especially explicit negations.",
    `task_kind: ${contract.kind}`,
    `task_type: ${contract.taskType || "general"}`,
    `categories: ${contract.categories.join(", ") || "general"}`,
    `semantic_domain: ${contract.semanticIntent?.domain || "unknown"}`,
    `semantic_operation: ${contract.semanticIntent?.operation || "unknown"}`,
    `semantic_sources: ${(contract.semanticIntent?.sourceKinds || []).join(", ") || "none"}`,
    `expected_output: ${contract.semanticIntent?.outputMode || "unknown"}`,
    `workspace_profile: ${contract.workspaceProfile || "unknown"}`,
    `workspace_signals: ${(contract.workspaceSignals || []).join(", ") || "none"}`,
    `registry_version: ${contract.registryVersion || "local-default"}`,
    "",
    "Platform baseline rules:",
    ...(contract.platformRules || PLATFORM_BASELINE_RULES).map((item) => `- ${item}`),
    "",
    "User negative constraints and blocked intents:",
    ...(
      contract.negativeConstraints?.length
        ? contract.negativeConstraints.map((item) => `- ${item.intent}: ${item.rule}`)
        : ["- none"]
    ),
    ...(
      contract.blockedIntents?.length
        ? ["", `Blocked intents: ${contract.blockedIntents.join(", ")}`]
        : []
    ),
    "",
    "Evidence gate:",
    `required: ${contract.evidencePolicy?.required ? "yes" : "no"}`,
    `allowed_sources: ${(contract.evidencePolicy?.allowedSources || []).join(", ") || "none"}`,
    `required_evidence_kinds: ${(contract.evidencePolicy?.requiredEvidenceKinds || []).join(", ") || "none"}`,
    contract.evidencePolicy?.unsupportedClaimPolicy || "",
    ...(contract.evidencePolicy?.finalAnswerRequirements?.length
      ? ["Final answer requirements:", ...contract.evidencePolicy.finalAnswerRequirements.map((item) => `- ${item}`)]
      : []),
    ...(contract.externalFactPolicy?.required
      ? [
          "",
          "External fact gate:",
          `reason_codes: ${(contract.externalFactPolicy.reasonCodes || []).join(", ") || "external_fact"}`,
          `requires_freshness: ${contract.externalFactPolicy.requiresFreshness ? "yes" : "no"}`,
          `requires_source_links: ${contract.externalFactPolicy.requiresSourceLinks ? "yes" : "no"}; research_prohibited_by_user: ${contract.externalFactPolicy.researchProhibited ? "yes" : "no"}`,
          `scope_clarification_recommended: ${contract.externalFactPolicy.scopeClarificationRecommended ? "yes" : "no"}; scope_clarification_required: ${contract.externalFactPolicy.scopeClarificationRequired ? "yes" : "no"}; scope_disclosure_required: ${contract.externalFactPolicy.scopeDisclosureRequired ? "yes" : "no"}; source_authority: ${contract.externalFactPolicy.sourceAuthority || "standard"}; authority_url_policy: ${contract.externalFactPolicy.verificationPlan?.authorityUrlPolicy || "none"}`,
          `claim_profiles: ${(contract.externalFactPolicy.verificationPlan?.profileIds || []).join(", ") || "none"}; claim_kinds: ${(contract.externalFactPolicy.verificationPlan?.claimKinds || []).join(", ") || "none"}`,
          `required_scope_dimensions: ${(contract.externalFactPolicy.verificationPlan?.requiredScopeDimensions || []).join(", ") || "none"}; resolved_scope_dimensions: ${(contract.externalFactPolicy.verificationPlan?.resolvedScopeDimensions || []).join(", ") || "none"}; scope_resolution_mode: ${contract.externalFactPolicy.verificationPlan?.scopeResolutionMode || "assume_and_disclose"}`,
          contract.externalFactPolicy.policy || "",
          ...contract.externalFactPolicy.finalAnswerRequirements.map((item) => `- ${item}`),
        ]
      : []),
    "",
    "Source coverage gate:",
    `required: ${contract.sourceCoveragePolicy?.required ? "yes" : "no"}`,
    `explicit_user_terms: ${(contract.sourceCoveragePolicy?.explicitTerms || []).join(", ") || "none"}`,
    contract.sourceCoveragePolicy?.policy || "",
    "",
    "Workspace grounding gate:",
    `required: ${contract.workspaceGroundingPolicy?.required ? "yes" : "no"}`,
    `mode: ${contract.workspaceGroundingPolicy?.mode || "reuse_existing_workspace"}`,
    `allow_new_top_level: ${contract.workspaceGroundingPolicy?.allowNewTopLevel ? "yes" : "no"}`,
    `required_evidence: ${(contract.workspaceGroundingPolicy?.requiredEvidence || []).join(", ") || "none"}`,
    contract.workspaceGroundingPolicy?.policy || "",
    "",
    "Host-resolved intent contract:",
    "This is the platform's durable baseline for the task. The current user instruction outranks inherited fields. Treat assumptions as provisional, not as facts.",
    JSON.stringify(compactIntentContract(contract.intentContract)),
    ...newTaskIsolation,
    "Ask a clarification only when criticalUnknowns is non-empty or when acting would be irreversible and materially ambiguous. For reversible research or analysis, choose a reasonable scope, disclose the assumption, verify it, and proceed; a question-only response does not complete the task.",
    "Do not claim the task complete until every deliverable and machine-verifiable success criterion has supporting evidence.",
    "If the session exposes lily_intent_contract_commit and your semantic interpretation materially improves the objective, deliverables, success criteria, assumptions, critical unknowns, or an unfamiliar external claim's verification plan, call it once before the first side effect. It is optional: if unavailable or rejected, continue immediately with this host baseline.",
    "",
    "Model task draft:",
    `schema_version: ${TASK_TYPE_SCHEMA_VERSION}`,
    "Before acting, internally draft a JSON object that matches this schema. Use it to refine impact surface and verification. Do not show the JSON unless the user asks.",
    JSON.stringify(contract.modelDraft?.schema || modelDraftSchema()),
    "",
    "Required operating mode:",
    "1. Establish the impact surface before editing or executing non-trivial work.",
    "2. Maintain an internal execution ledger: inspected, changed, verified, remaining risk.",
    "3. If tool output is needed, keep progress visible and do not silently wait.",
    "4. Before the final answer, pass a verification gate: state exactly what was verified, or explicitly say what could not be verified.",
    "5. If the task is small/read-only, keep the process lightweight but still ground the answer in available context.",
    "",
    "Impact checklist:",
    ...contract.checklist.slice(0, 24).map((item) => `- ${item}`),
    "",
    "Verification strategy:",
    ...(contract.verificationStrategy || []).slice(0, 20).map((item) => `- ${item}`),
    "</lily_task_contract>",
  ].join("\n");
  return addLayersToEngineText(text, {
    executionConstraints: contractText,
  });
}

module.exports = {
  DEFAULT_TASK_INTELLIGENCE_REGISTRY,
  buildTaskContract,
  buildVerificationStrategy,
  buildEvidencePolicy,
  buildSourceCoveragePolicy,
  buildWorkspaceGroundingPolicy,
  classifyTask,
  detectWorkspaceProfile,
  extractNegativeConstraints,
  loadTaskIntelligenceRegistry,
  mergeTaskIntelligenceRegistry,
  withTaskContractPrefix,
};
