"use strict";

/**
 * Pure catalog data for optional dependency packs — no electron or runtime
 * dependencies, so the installer, settings UI, MCP tools, agent-facing skill,
 * and offline build scripts share one source of truth.
 *
 * The desktop app bundles only the base Python/Node runtime. Heavy or optional
 * libraries are published as prebuilt artifacts on Lily's CDN; installing a
 * pack downloads, verifies, and extracts that artifact instead of running pip or
 * npm on the user's machine.
 */
const PACK_CATEGORIES = [
  {
    id: "document",
    label: {
      en: "Document processing",
      "zh-CN": "文档处理",
      ar: "معالجة المستندات",
    },
  },
  {
    id: "image",
    label: {
      en: "Image processing",
      "zh-CN": "图片处理",
      ar: "معالجة الصور",
    },
  },
  {
    id: "browser",
    label: {
      en: "Browser automation",
      "zh-CN": "浏览器自动化",
      ar: "أتمتة المتصفح",
    },
  },
  {
    id: "media",
    label: {
      en: "Audio and video processing",
      "zh-CN": "音视频处理",
      ar: "معالجة الصوت والفيديو",
    },
  },
];

const PACK_SPECS = {
  libreoffice: {
    id: "libreoffice",
    category: "document",
    installKind: "native-archive",
    recommended: true,
    sizeEstimate: "≈450-800MB download / ≈1.2GB installed",
    pathEntries: ["LibreOffice.app/Contents/MacOS", "program", "Program", "libreoffice/program"],
    health: { kind: "libreoffice" },
    label: {
      en: "LibreOffice",
      "zh-CN": "LibreOffice",
      ar: "LibreOffice",
    },
    description: {
      en: "Office conversion, document rendering, spreadsheet recalculation, thumbnails, and visual verification.",
      "zh-CN": "Office 转换、文档渲染、表格公式重算、缩略图和可视化校验。",
      ar: "تحويل Office وعرض المستندات وإعادة حساب الجداول والصور المصغرة والتحقق البصري.",
    },
  },
  "pro-pdf": {
    id: "pro-pdf",
    category: "document",
    installKind: "python-target",
    pythonPath: true,
    recommended: true,
    requirements: ["docling>=2,<3"],
    probe: "import docling",
    sizeEstimate: "≈230MB download / ≈900MB installed",
    label: {
      en: "Docling",
      "zh-CN": "Docling",
      ar: "Docling",
    },
    description: {
      en: "High-accuracy PDF layout analysis, reading order, and table-structure recovery for complex PDFs.",
      "zh-CN": "复杂 PDF 的高精度版面分析、阅读顺序和表格结构还原。",
      ar: "تحليل تخطيط PDF عالي الدقة وترتيب القراءة واستعادة بنية الجداول.",
    },
  },
  "large-document": {
    id: "large-document",
    category: "document",
    installKind: "python-target",
    pythonPath: true,
    recommended: true,
    requirements: [
      "PyMuPDF>=1.24,<2",
      "pikepdf>=9,<11",
      "python-calamine>=0.2,<1",
      "duckdb>=1.1,<2",
      "pyarrow>=15,<23",
      "polars>=1,<2",
      "ijson>=3,<4",
      "orjson>=3,<4",
      "zstandard>=0.22,<1",
    ],
    probe: "import fitz, pikepdf, python_calamine, duckdb, pyarrow, polars, ijson, orjson, zstandard",
    sizeEstimate: "≈120-500MB download / varies by platform",
    label: {
      en: "Large document engine",
      "zh-CN": "大文件文档引擎",
      ar: "محرك المستندات الكبيرة",
    },
    description: {
      en: "Streaming and indexed handling for large PDFs, Word files, Excel workbooks, CSV/JSON, and columnar data without loading everything into memory.",
      "zh-CN": "大 PDF、Word、Excel、CSV/JSON 和列式数据的流式读取与索引处理，避免整文件读入内存。",
      ar: "معالجة وفهرسة تدفقية لملفات PDF وWord وExcel وCSV/JSON الكبيرة والبيانات العمودية دون تحميلها كاملة في الذاكرة.",
    },
  },
  pandoc: {
    id: "pandoc",
    category: "document",
    installKind: "native-tool",
    sizeEstimate: "≈35-100MB download / varies by platform",
    pathEntries: ["bin", "."],
    health: { executables: [{ name: "pandoc", args: ["--version"] }] },
    label: {
      en: "Pandoc",
      "zh-CN": "Pandoc",
      ar: "Pandoc",
    },
    description: {
      en: "High-quality Markdown, HTML, LaTeX, EPUB, and document format conversion for advanced document workflows.",
      "zh-CN": "高质量 Markdown、HTML、LaTeX、EPUB 等文档格式转换，供高级文档流程使用。",
      ar: "تحويل عالي الجودة بين Markdown وHTML وLaTeX وEPUB وتنسيقات مستندات أخرى.",
    },
  },
  pillow: {
    id: "pillow",
    category: "image",
    installKind: "python-target",
    pythonPath: true,
    baseModule: "PIL",
    requirements: ["Pillow>=10.4,<12"],
    probe: "from PIL import Image",
    sizeEstimate: "≈5-30MB download / varies by platform",
    label: {
      en: "Pillow",
      "zh-CN": "Pillow",
      ar: "Pillow",
    },
    description: {
      en: "Core image opening, resizing, conversion, thumbnails, and format inspection.",
      "zh-CN": "基础图片打开、缩放、转换、缩略图和格式识别。",
      ar: "فتح الصور وتغيير حجمها وتحويلها والصور المصغرة وفحص التنسيق.",
    },
  },
  opencv: {
    id: "opencv",
    category: "image",
    installKind: "python-target",
    pythonPath: true,
    baseModule: "cv2",
    requirements: ["opencv-python-headless>=4.10,<5"],
    probe: "import cv2",
    sizeEstimate: "≈40-120MB download / varies by platform",
    label: {
      en: "OpenCV",
      "zh-CN": "OpenCV",
      ar: "OpenCV",
    },
    description: {
      en: "Image preprocessing, contour detection, transforms, and computer-vision utilities without GUI bindings.",
      "zh-CN": "图片预处理、轮廓检测、变换和计算机视觉工具，不包含 GUI 绑定。",
      ar: "معالجة الصور المسبقة وكشف الحواف والتحويلات وأدوات الرؤية الحاسوبية بدون واجهات GUI.",
    },
  },
  rapidocr: {
    id: "rapidocr",
    category: "image",
    installKind: "python-target",
    pythonPath: true,
    baseModule: "rapidocr_onnxruntime",
    requirements: ["rapidocr-onnxruntime>=1.3,<2"],
    probe: "from rapidocr_onnxruntime import RapidOCR",
    sizeEstimate: "≈40-160MB download / varies by platform",
    label: {
      en: "RapidOCR",
      "zh-CN": "RapidOCR",
      ar: "RapidOCR",
    },
    description: {
      en: "Local OCR for scanned documents and images using ONNX Runtime, without torch.",
      "zh-CN": "基于 ONNX Runtime 的本地 OCR，用于扫描文档和图片，不依赖 torch。",
      ar: "OCR محلي للمستندات الممسوحة والصور باستخدام ONNX Runtime بدون torch.",
    },
  },
  rembg: {
    id: "rembg",
    category: "image",
    installKind: "python-target",
    pythonPath: true,
    pythonPathPriority: 50,
    requirements: ["rembg>=2,<3", "numpy>=1.26,<2.5", "numba>=0.61"],
    probe: "import rembg",
    sizeEstimate: "≈80-250MB download / varies by platform",
    label: {
      en: "rembg",
      "zh-CN": "rembg",
      ar: "rembg",
    },
    description: {
      en: "Local image background removal dependency for product photos and cutout workflows.",
      "zh-CN": "本地图片抠图和背景移除依赖，适合商品图与素材处理。",
      ar: "تبعية محلية لإزالة خلفية الصور ومعالجة صور المنتجات والقصاصات.",
    },
  },
  "web-automation": {
    id: "web-automation",
    category: "browser",
    installKind: "node-browser-runtime",
    sizeEstimate: "≈250-350MB download / varies by platform",
    envEntries: {
      NODE_PATH: "node_modules",
      LILY_PLAYWRIGHT_NODE_MODULES: "node_modules",
      PLAYWRIGHT_BROWSERS_PATH: "browsers",
    },
    pathEntries: ["bin"],
    health: { nodeModule: "playwright", browserDir: "browsers" },
    label: {
      en: "Playwright",
      "zh-CN": "Playwright",
      ar: "Playwright",
    },
    description: {
      en: "Node Playwright modules plus browser binaries for web learning, authenticated QA, and controlled browser automation.",
      "zh-CN": "网页学习、登录态 QA 和受控浏览器自动化所需的 Node Playwright 模块与浏览器二进制。",
      ar: "وحدات Node Playwright وملفات المتصفح لأتمتة الويب والتعلم والاختبار.",
    },
  },
  ffmpeg: {
    id: "ffmpeg",
    category: "media",
    installKind: "native-tool",
    sizeEstimate: "≈30-120MB download / varies by platform",
    pathEntries: ["bin", "."],
    health: {
      executables: [
        { name: "ffmpeg", args: ["-version"] },
        { name: "ffprobe", args: ["-version"] },
      ],
    },
    label: {
      en: "FFmpeg",
      "zh-CN": "FFmpeg",
      ar: "FFmpeg",
    },
    description: {
      en: "Local audio/video probing, conversion, clipping, and packaging for media workflows.",
      "zh-CN": "本地音视频探测、转码、裁剪与封装，供媒体类任务使用。",
      ar: "فحص وتحويل وقص وتجميع الصوت والفيديو محلياً لمهام الوسائط.",
    },
  },
};

module.exports = { PACK_CATEGORIES, PACK_SPECS };
