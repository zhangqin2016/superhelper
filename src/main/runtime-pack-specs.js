"use strict";

/**
 * Pure catalog data for optional runtime packs — no electron or
 * runtime dependencies, so both the install mechanism (`runtime-packs.js`) and
 * the offline build script (`scripts/build-runtime-pack.mjs`) share one source
 * of truth for each pack's pip requirements and import probe.
 *
 * `requirements` feed the build (`uv pip install --target`) and the dev/offline
 * uv fallback; `probe` is the import that must succeed for the pack to be ready.
 */
const PACK_SPECS = {
  "pro-pdf": {
    id: "pro-pdf",
    requirements: ["docling>=2,<3"],
    probe: "import docling",
    sizeEstimate: "≈230MB download / ≈900MB installed",
    label: {
      en: "Pro PDF engine (Docling)",
      "zh-CN": "专业 PDF 引擎(Docling)",
    },
    description: {
      en: "Layout analysis, reading order, and table-structure recovery for complex PDFs, contracts, and reports. Pulls heavy ML deps — for capable machines.",
      "zh-CN": "复杂 PDF/合同/财报的版面分析、阅读顺序与表格结构还原。含重型 ML 依赖,建议高配机器。",
    },
  },
};

module.exports = { PACK_SPECS };
