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
  priority: ["release", "runtime", "agent_quality", "server", "ui", "bugfix", "config", "code", "document", "media"],
  activatingCategories: ["bugfix", "ui", "server", "release", "runtime", "agent_quality", "config", "code"],
  categories: {
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
      terms: ["image", "video", "audio", "voice", "图片", "视频", "语音", "截图", "识别", "生成图"],
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
      ui: ["For UI work, verify the visible state, empty/loading/error states, and repeated interaction path."],
      server: ["For server work, verify auth boundaries, persistence, migrations, and public/admin route differences."],
      release: ["For release/deploy work, verify artifact names, update manifest, upload target, and live version after publish."],
      config: ["For config/model work, separate local override, server-managed config, secret handling, and inactive-device update access."],
      document: ["For document work, verify page coverage, OCR needs, tables/images, output format, and whether the output opens."],
      media: ["For media work, keep generation progress visible and provide a preview or directly openable path."],
    },
  },
});

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : null;
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
  for (const profile of Array.isArray(remoteProfiles) ? remoteProfiles : []) {
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
  const normalizedRemote = remote && typeof remote === "object" ? remote : {};
  const categories = {};
  const categoryIds = new Set([
    ...Object.keys(base.categories || {}),
    ...Object.keys(normalizedRemote.categories || {}),
  ]);
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
    enabled: normalizedRemote.enabled !== false && base.enabled !== false,
    fileExtensions: uniqueStrings(base.fileExtensions, normalizedRemote.fileExtensions),
    priority: nonEmptyStrings(normalizedRemote.priority) || arrayOfStrings(base.priority) || [],
    activatingCategories:
      nonEmptyStrings(normalizedRemote.activatingCategories) || arrayOfStrings(base.activatingCategories) || [],
    categories,
    workspaceSignals: mergeWorkspaceProfiles(base.workspaceSignals, normalizedRemote.workspaceSignals),
    workspaceProfiles: mergeWorkspaceProfiles(base.workspaceProfiles, normalizedRemote.workspaceProfiles),
    verificationStrategies: mergeVerificationStrategies(base.verificationStrategies, normalizedRemote.verificationStrategies),
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
  const explicit = source.match(/(?:不要|别|无需|不需要|不用|禁止|不是|并非|do not|don't|dont|never|no need to|not)\s*[^，。；;.!?\n]{0,80}/gi);
  for (const item of explicit || []) {
    const value = item.trim();
    if (!value) continue;
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

  const activatingCategories = new Set(arrayOfStrings(registry.activatingCategories) || []);
  const taskType = canonicalTaskTypeFromCategories(categories);
  const definition = taskTypeDefinition(taskType);
  const active = categories.some((category) => activatingCategories.has(category)) || Boolean(definition.active);
  const kind = (arrayOfStrings(registry.priority) || []).find((category) => categories.includes(category)) || "general";
  return {
    active,
    kind,
    taskType,
    categories,
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

function buildImpactChecklist(classification, profile, registry = loadTaskIntelligenceRegistry()) {
  const checklists = registry.checklists || {};
  const checklist = uniqueStrings(checklists.base);
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

function evidenceSourcesForTaskType(taskType) {
  const common = ["user_request", "tool_output"];
  switch (taskType) {
    case "bug_investigation":
    case "runtime_protocol":
    case "code_change":
    case "agent_quality":
      return uniqueStrings([
        ...common,
        "code_file_reference",
        "test_or_command_output",
        "runtime_event_or_log",
        "official_history_or_fixture",
      ]);
    case "release_deploy":
      return uniqueStrings([
        ...common,
        "artifact_or_version_manifest",
        "upload_or_deploy_command_output",
        "live_service_check",
      ]);
    case "server_change":
      return uniqueStrings([
        ...common,
        "route_or_service_code_reference",
        "database_or_migration_record",
        "api_response_or_server_log",
        "server_test_output",
      ]);
    case "ui_change":
      return uniqueStrings([
        ...common,
        "renderer_code_reference",
        "screenshot_or_dom_observation",
        "renderer_test_or_manual_check",
      ]);
    case "configuration_change":
      return uniqueStrings([
        ...common,
        "config_file_or_database_record",
        "effective_runtime_config",
        "secret_boundary_check",
      ]);
    default:
      return uniqueStrings(common);
  }
}

function buildEvidencePolicy(classification) {
  const taskType = classification?.taskType || "general";
  const active = Boolean(classification?.active);
  return {
    required: active,
    allowedSources: evidenceSourcesForTaskType(taskType),
    unsupportedClaimPolicy: active
      ? "Unsupported factual claims must be downgraded to uncertainty. Do not state causes, completion, deployment, correctness, data values, or external facts as confirmed without an allowed evidence source."
      : "Use evidence when making factual claims; if evidence is unavailable, say what is unknown instead of inventing details.",
    finalAnswerRequirements: active
      ? [
          "For each important conclusion, cite the evidence type used.",
          "If evidence is missing, explicitly say it is unverified or unknown.",
          "Do not claim fixed/completed/deployed/verified unless tool output or a concrete record supports it.",
        ]
      : [],
  };
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
  const required = Boolean(classification.active && terms.length);
  return {
    required,
    explicitTerms: terms,
    policy: required
      ? "Before making codebase or architecture claims, search for the user's explicit terms in paths, filenames, symbols, docs, and fixtures. Do not substitute a neighboring subsystem or acronym unless evidence proves it is part of the requested scope."
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
    ["code", "ui", "server", "runtime", "config", "bugfix", "agent_quality", "release"].some((category) =>
      categories.has(category),
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

function buildLocalDraft({ text, classification, profile, verificationStrategy }) {
  return {
    schemaVersion: TASK_TYPE_SCHEMA_VERSION,
    taskType: classification.taskType,
    objective: String(text || "").trim().slice(0, 500),
    impactSurface: profile.hints || [],
    assumptions: [],
    risks: [],
    verificationPlan: verificationStrategy,
  };
}

function buildTaskContract({ text = "", files = [], session = null, project = null } = {}) {
  const registry = loadTaskIntelligenceRegistry();
  const classification = classifyTask({ text, files, registry });
  const negativeConstraints = extractNegativeConstraints(text);
  if (!classification.active) {
    return {
      active: false,
      kind: classification.kind,
      taskType: classification.taskType,
      categories: classification.categories,
      negativeConstraints,
      evidencePolicy: buildEvidencePolicy(classification),
      sourceCoveragePolicy: buildSourceCoveragePolicy({ text, classification }),
      workspaceGroundingPolicy: buildWorkspaceGroundingPolicy({
        text,
        classification,
        profile: { type: "unknown", signals: [] },
      }),
    };
  }
  const projectPath = project?.path || session?.workspacePath || "";
  const profile = detectWorkspaceProfile(projectPath, registry);
  const checklist = buildImpactChecklist(classification, profile, registry);
  const verificationStrategy = buildVerificationStrategy(classification, registry);
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
    evidencePolicy: buildEvidencePolicy(classification),
    sourceCoveragePolicy: buildSourceCoveragePolicy({ text, classification }),
    workspaceGroundingPolicy: buildWorkspaceGroundingPolicy({ text, classification, profile }),
    checklist,
    verificationStrategy,
    modelDraft: {
      requested: true,
      schema: modelDraftSchema(),
      localFallback: buildLocalDraft({ text, classification, profile, verificationStrategy }),
    },
  };
}

function withTaskContractPrefix(text, contract) {
  if (!contract?.active) return String(text || "");
  const { addLayersToEngineText } = require("./engine-message-layers");
  const contractText = [
    "<lily_task_contract>",
    "This internal contract improves execution quality. Do not quote it back unless the user asks about process.",
    "The user's original request remains the highest-priority instruction, especially explicit negations.",
    `task_kind: ${contract.kind}`,
    `task_type: ${contract.taskType || "general"}`,
    `categories: ${contract.categories.join(", ") || "general"}`,
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
    contract.evidencePolicy?.unsupportedClaimPolicy || "",
    ...(contract.evidencePolicy?.finalAnswerRequirements?.length
      ? ["Final answer requirements:", ...contract.evidencePolicy.finalAnswerRequirements.map((item) => `- ${item}`)]
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
    ...contract.checklist.map((item) => `- ${item}`),
    "",
    "Verification strategy:",
    ...(contract.verificationStrategy || []).map((item) => `- ${item}`),
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
