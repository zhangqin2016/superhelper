"use strict";

/**
 * Pure catalog data for optional runtime packs — no electron or runtime
 * dependencies, so the installer, settings UI, MCP tools, agent-facing skill,
 * and offline build scripts share one source of truth.
 *
 * Python target packs use `requirements` + `probe` and can be built by
 * scripts/build-runtime-pack.mjs. Native/toolchain packs are artifact-only:
 * they are built/published by their dedicated release pipeline, then resolved
 * by the same server artifact endpoint.
 */
const PACK_CATEGORIES = [
  {
    id: "system",
    label: {
      en: "System runtimes",
      "zh-CN": "系统运行环境",
      ar: "بيئات تشغيل النظام",
    },
  },
  {
    id: "common",
    label: {
      en: "Common runtimes",
      "zh-CN": "常用运行环境",
      ar: "بيئات تشغيل شائعة",
    },
  },
];

const PACK_SPECS = {
  libreoffice: {
    id: "libreoffice",
    category: "system",
    installKind: "native-archive",
    recommended: true,
    sizeEstimate: "≈450-800MB download / ≈1.2GB installed",
    label: {
      en: "LibreOffice runtime",
      "zh-CN": "LibreOffice 运行环境",
      ar: "بيئة تشغيل LibreOffice",
    },
    description: {
      en: "Local Office conversion, document rendering, spreadsheet recalculation, thumbnails, and visual verification. Required when the base app has no bundled office runtime.",
      "zh-CN": "本地 Office 转换、文档渲染、表格公式重算、缩略图和可视化校验。基础包未内置办公运行环境时需要安装。",
      ar: "تحويل Office محلياً، وعرض المستندات، وإعادة حساب الجداول، والصور المصغرة، والتحقق البصري. مطلوب عندما لا تتضمن الحزمة الأساسية بيئة Office.",
    },
  },
  "pro-pdf": {
    id: "pro-pdf",
    category: "system",
    installKind: "python-target",
    pythonPath: true,
    recommended: true,
    requirements: ["docling>=2,<3"],
    probe: "import docling",
    sizeEstimate: "≈230MB download / ≈900MB installed",
    label: {
      en: "Pro PDF engine (Docling)",
      "zh-CN": "专业 PDF 引擎(Docling)",
      ar: "محرك PDF احترافي (Docling)",
    },
    description: {
      en: "Layout analysis, reading order, and table-structure recovery for complex PDFs, contracts, and reports. Pulls heavy ML deps — for capable machines.",
      "zh-CN": "复杂 PDF/合同/财报的版面分析、阅读顺序与表格结构还原。含重型 ML 依赖,建议高配机器。",
      ar: "تحليل التخطيط وترتيب القراءة واستعادة الجداول لملفات PDF المعقدة والعقود والتقارير. يتضمن تبعيات تعلم آلي ثقيلة.",
    },
  },
  "web-automation": {
    id: "web-automation",
    category: "common",
    installKind: "node-browser-runtime",
    sizeEstimate: "≈150-350MB download / varies by platform",
    envEntries: {
      NODE_PATH: "node_modules",
      LILY_PLAYWRIGHT_NODE_MODULES: "node_modules",
      PLAYWRIGHT_BROWSERS_PATH: "browsers",
    },
    pathEntries: ["bin"],
    label: {
      en: "Web automation runtime (Playwright)",
      "zh-CN": "网页自动化运行环境(Playwright)",
      ar: "بيئة أتمتة الويب (Playwright)",
    },
    description: {
      en: "Playwright modules plus browser binaries for web learning, authenticated QA, and controlled browser automation when they are not bundled with the app.",
      "zh-CN": "网页学习、登录态 QA 和受控浏览器自动化所需的 Playwright 模块与浏览器二进制；基础包未内置时安装。",
      ar: "وحدات Playwright مع ملفات المتصفح لأتمتة الويب والتعلم والاختبار عند عدم تضمينها في التطبيق.",
    },
  },
  ffmpeg: {
    id: "ffmpeg",
    category: "common",
    installKind: "native-tool",
    sizeEstimate: "≈30-120MB download / varies by platform",
    pathEntries: ["bin", "."],
    label: {
      en: "FFmpeg media tools",
      "zh-CN": "FFmpeg 音视频工具",
      ar: "أدوات الوسائط FFmpeg",
    },
    description: {
      en: "Local audio/video probing, conversion, clipping, and packaging for media workflows.",
      "zh-CN": "本地音视频探测、转码、裁剪与封装，供媒体类任务使用。",
      ar: "فحص وتحويل وقص وتجميع الصوت والفيديو محلياً لمهام الوسائط.",
    },
  },
  pandoc: {
    id: "pandoc",
    category: "common",
    installKind: "native-tool",
    sizeEstimate: "≈35-100MB download / varies by platform",
    pathEntries: ["bin", "."],
    label: {
      en: "Pandoc document converter",
      "zh-CN": "Pandoc 文档转换器",
      ar: "محول المستندات Pandoc",
    },
    description: {
      en: "High-quality Markdown, HTML, LaTeX, EPUB, and document format conversion for advanced document workflows.",
      "zh-CN": "高质量 Markdown、HTML、LaTeX、EPUB 等文档格式转换，供高级文档流程使用。",
      ar: "تحويل عالي الجودة بين Markdown وHTML وLaTeX وEPUB وتنسيقات مستندات أخرى.",
    },
  },
};

module.exports = { PACK_CATEGORIES, PACK_SPECS };
