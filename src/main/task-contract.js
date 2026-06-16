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
  priority: ["release", "runtime", "server", "ui", "bugfix", "config", "code", "document", "media"],
  activatingCategories: ["bugfix", "ui", "server", "release", "runtime", "config", "code"],
  categories: {
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
        "代码",
        "脚本",
        "实现",
        "测试",
        "提交",
        "函数",
        "组件",
        "模块",
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

function attachedCodeFiles(files = [], registry = loadTaskIntelligenceRegistry()) {
  const codeExtensions = new Set(arrayOfStrings(registry.fileExtensions) || []);
  return files.some((file) => {
    const name = file?.name || file?.path || file?.fileName || "";
    return codeExtensions.has(path.extname(String(name)).toLowerCase());
  });
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
  const haystack = lowerText(text);
  const categories = [];
  for (const [category, config] of Object.entries(registry.categories || {})) {
    if (includesAny(haystack, config?.terms || [])) categories.push(category);
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
  if (!classification.active) {
    return {
      active: false,
      kind: classification.kind,
      taskType: classification.taskType,
      categories: classification.categories,
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
  const lines = [
    "<lily_task_contract>",
    "This internal contract improves execution quality. Do not quote it back unless the user asks about process.",
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
    "",
    String(text || ""),
  ];
  return lines.join("\n");
}

module.exports = {
  DEFAULT_TASK_INTELLIGENCE_REGISTRY,
  buildTaskContract,
  buildVerificationStrategy,
  classifyTask,
  detectWorkspaceProfile,
  loadTaskIntelligenceRegistry,
  mergeTaskIntelligenceRegistry,
  withTaskContractPrefix,
};
