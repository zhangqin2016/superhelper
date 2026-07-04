"use strict";

const BASE_CAPABILITIES = [
  {
    id: "dependency.install",
    family: "dependency",
    title: "Install or repair optional dependency packs",
    triggers: ["dependency missing", "install runtime", "large pdf", "ocr", "ffmpeg", "playwright"],
    route: "Use Lily runtime-pack tools (runtime_pack_list/runtime_pack_install), or read the lily-runtime-packs guide and run its script. Do not invoke OpenCode native `skill lily-*`. Long installs must run through lily_process_jobs.",
    failOpen: "If unavailable, fail open: continue with bundled capabilities and state the missing pack.",
  },
  {
    id: "file.index",
    family: "file",
    title: "Index and query large files or folders",
    triggers: ["large document", "many files", "search within folder", "query pdf", "analyze workbook"],
    route: "Use file intelligence tools or document extraction scripts. Do not read huge files wholesale into prompt.",
    failOpen: "If indexing fails, fail open: use path-first CLI/file tools and disclose partial evidence.",
  },
  {
    id: "process.job",
    family: "execution",
    title: "Run long tasks with progress and recovery",
    triggers: ["long scan", "batch convert", "dependency install", "web learning", "video processing"],
    route: "Use lily_process_jobs job_start/job_status/job_logs for long deterministic work.",
    failOpen: "If the supervisor is unavailable, fail open: use foreground tools only and do not claim background progress.",
  },
  {
    id: "artifact.reveal",
    family: "artifact",
    title: "Register, preview, and reveal generated files",
    triggers: ["generated image", "open file location", "preview artifact", "show output"],
    route: "Use artifact registry/local media protocol and absolute file evidence.",
    failOpen: "If preview cannot render, fail open: show the path and keep reveal/copy affordances.",
  },
  {
    id: "web.learn",
    family: "web",
    title: "Learn a web system into a workspace skill",
    triggers: ["learn website", "learn admin system", "automate portal", "web app operation"],
    route: "Use lily-web-system-learning orchestrator; normal usage must prefer learned API/playbook execution.",
    failOpen:
      "If learning cannot authenticate or converge, fail open: produce a partial draft with gaps instead of ad-hoc browser loops.",
  },
];

const OPERATION_INTENT_PATTERN =
  /(依赖|安装|修复|检查|分析|读取|解析|转换|索引|查询|搜索|总结|生成|导出|导入|学习|扫描|自动化|网页|网站|系统|PDF|pdf|Word|word|Excel|excel|图片|图像|视频|音频|OCR|ocr|runtime|dependency|install|repair|analy[sz]e|read|parse|convert|index|search|summari[sz]e|generate|export|import|learn|scan|automate|browser|website|document|image|video|audio|ffmpeg|playwright)/i;

function normalizeCapability(item) {
  return {
    id: String(item?.id || "").trim(),
    family: String(item?.family || "general").trim(),
    title: String(item?.title || "").trim(),
    triggers: Array.isArray(item?.triggers) ? item.triggers.map(String).filter(Boolean) : [],
    route: String(item?.route || "").trim(),
    failOpen: String(item?.failOpen || "Fail open to today's behavior.").trim(),
  };
}

function listCapabilities(extra = []) {
  return [...BASE_CAPABILITIES, ...extra].map(normalizeCapability).filter((item) => item.id && item.title);
}

function compactCapabilityContext(opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(500, opts.maxChars) : 4000;
  const lines = [
    "Lily chat-native capabilities:",
    ...listCapabilities(opts.extra).map(
      (item) => `- ${item.id}: ${item.title}. Route: ${item.route} Fail-open: ${item.failOpen}`
    ),
  ];
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 25))}\n[capabilities truncated]`;
}

function shouldInjectCapabilityContext(opts = {}) {
  if (Array.isArray(opts.files) && opts.files.length > 0) return true;
  if (opts.dependencyAdvisory?.text) return true;
  if (opts.turnPolicy?.rigor === "grounded" || opts.turnPolicy?.rigor === "coverage") return true;
  const text = String(opts.text || "");
  return OPERATION_INTENT_PATTERN.test(text);
}

module.exports = {
  listCapabilities,
  compactCapabilityContext,
  shouldInjectCapabilityContext,
};
