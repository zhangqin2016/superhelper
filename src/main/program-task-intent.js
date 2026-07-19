"use strict";

const path = require("node:path");

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".html", ".java", ".js", ".jsx",
  ".json", ".kt", ".mjs", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql",
  ".swift", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
]);

const TARGET_SIGNALS = Object.freeze({
  program: /程序|软件|应用程序|小程序|program|software|application/i,
  app: /应用|小工具|客户端|服务端|app|tool|client|server/i,
  website: /网站|网页|后台|管理系统|website|web app|dashboard|admin/i,
  script: /脚本|自动化|script|automation/i,
  api: /接口|服务|api|service/i,
  game: /游戏|game/i,
  codebase: /代码|源码|模块|组件|函数|仓库|项目|code|source|module|component|function|repository|repo|project/i,
});

const OPERATION_SIGNALS = Object.freeze({
  debug: /修复|排查|调试|解决.{0,12}(?:报错|错误|问题)|fix|debug|resolve.{0,12}(?:bug|error|issue)/i,
  refactor: /重构|重新设计.{0,12}(?:代码|架构|模块)|refactor|re-architect/i,
  optimize: /优化|提速|降低.{0,12}(?:延迟|内存)|性能|可靠性|稳定性|optimi[sz]e|performance|reliability|stability/i,
  implement: /写|开发|实现|构建|搭建|创建|制作|做一个|生成|接入|增加|添加|build|develop|implement|create|make|write|add|integrate/i,
  inspect: /分析|解释|检查|审查|阅读|是什么|怎么工作|analy[sz]e|explain|inspect|review|read|how.{0,8}work/i,
});

const QUALITY_SIGNALS = Object.freeze({
  production: /生产级|上线级|可上线|production[- ]ready|ship[- ]ready/i,
  high_quality: /高质量|牛逼|顶级|专业|健壮|优秀|high quality|top[- ]tier|professional|robust/i,
  tested: /测试|验证|回归|test|verify|regression/i,
  secure: /安全|权限|鉴权|secure|security|auth/i,
  maintainable: /可维护|可扩展|架构|maintainable|extensible|architecture/i,
});

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function codeAttachmentCount(files = []) {
  return (Array.isArray(files) ? files : []).filter((file) => {
    const input = file && typeof file === "object" ? file : {};
    return CODE_EXTENSIONS.has(path.extname(String(input.name || input.path || input.fileName || "")).toLowerCase());
  }).length;
}

function matchedKeys(text, patterns) {
  return Object.entries(patterns).filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
}

function selectedOperation(text) {
  for (const operation of ["debug", "refactor", "optimize", "implement", "inspect"]) {
    if (OPERATION_SIGNALS[operation].test(text)) return operation;
  }
  return "unknown";
}

function inferProgramTaskIntent({ text = "", files = [] } = {}) {
  const source = String(text || "").trim();
  const targets = matchedKeys(source, TARGET_SIGNALS);
  const attachmentCount = codeAttachmentCount(files);
  const operation = selectedOperation(source);
  const hasAction = operation !== "unknown";
  const hasTarget = targets.length > 0 || attachmentCount > 0;
  const active = hasAction && hasTarget;
  const workspaceAnchored = attachmentCount > 0 || /现有|当前|这个|这段|项目里|仓库里|代码库|existing|current|this|repository|repo|codebase/i.test(source);
  const qualitySignals = matchedKeys(source, QUALITY_SIGNALS);
  return {
    schemaVersion: 1,
    active,
    domain: "programming",
    operation,
    sourceKinds: unique([workspaceAnchored ? "workspace" : "", attachmentCount ? "code_attachment" : ""]),
    targetKinds: targets,
    outputMode: operation === "inspect" ? "answer" : "workspace_change",
    confidence: active ? targets.length && hasAction ? "high" : "medium" : "low",
    routeTaskType: active ? "code_change" : "",
    qualitySignals,
    reasonCodes: unique([
      hasAction ? `operation_${operation}` : "",
      targets.length ? "program_target" : "",
      attachmentCount ? "code_attachment" : "",
      workspaceAnchored ? "workspace_anchored" : "",
      qualitySignals.length ? "quality_requirements" : "",
    ]),
  };
}

module.exports = {
  inferProgramTaskIntent,
};
