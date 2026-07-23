"use strict";

// Platform corrections for bundled upstream skills. Keeping these outside the
// vendored skill files lets upstream updates apply cleanly while Lily retains
// authority over its runtime and delivery contract.
const SKILL_PLATFORM_OVERLAYS = Object.freeze({
  "anthropics-docx": Object.freeze({
    en: "anthropics-docx: Lily's bundled python-docx is the canonical scratch-authoring route. The absence of the Node docx package does not mean Word generation is unavailable. Preserve supplied templates when present. CJK contract: always set the font PAIR — ascii/hAnsi latin font AND w:eastAsia CJK font (e.g. Arial + Microsoft YaHei) — on document defaults and every style; a latin-only font guarantees per-machine CJK fallback drift. Apply it uniformly with style_docx() from resources/runtime-scripts/lily_office_style.py. Render and inspect the output before claiming delivery verification.",
    zh: "anthropics-docx：Lily 内置的 python-docx 是从零生成 Word 的标准路线；缺少 Node docx 包不代表平台不能生成 Word。有模板时优先保真编辑模板。中文排版契约：字体必须成对设置——ascii/hAnsi 西文字体 + w:eastAsia 中文字体（如 Arial + 微软雅黑），覆盖文档默认值和每个样式；只设西文字体必然导致各机器中文替换字体漂移。统一用 resources/runtime-scripts/lily_office_style.py 的 style_docx() 应用。交付前必须渲染并实际检查成品。",
  }),
  "anthropics-pptx": Object.freeze({
    en: "anthropics-pptx: Lily's bundled python-pptx is the canonical scratch-authoring route; missing pptxgenjs is not missing presentation capability. Default to LIGHT slide backgrounds; use dark backgrounds only when background AND light text colors are set as a pair and pass a contrast check (LIGHT_THEME / contrast_ok in resources/runtime-scripts/lily_office_style.py). Set latin + East-Asian typefaces as a pair on every run (style_pptx in the same helper). Subagent QA is use-if-available. Otherwise run the same visual QA inline and never skip it.",
    zh: "anthropics-pptx：Lily 内置的 python-pptx 是从零生成演示文稿的标准路线；缺少 pptxgenjs 不代表平台没有 PPT 能力。幻灯片默认使用浅色背景；只有背景色与浅色文字成对设置并通过对比度自检时才允许深色背景（见 resources/runtime-scripts/lily_office_style.py 的 LIGHT_THEME / contrast_ok）。每个文本 run 都要成对设置西文 + 东亚字体（同文件的 style_pptx）。子代理 QA 可用则用，否则在当前会话内联执行同样的视觉检查，绝不能跳过。",
  }),
  "anthropics-pdf": Object.freeze({
    en: "anthropics-pdf: probe ReportLab and use it for direct drawn PDFs when importable; stale runtimes without it must fall back to a structured DOCX/source plus managed LibreOffice export. Use pypdf for deterministic manipulation and LILY_CJK_FONT_PATH for non-Latin drawing. Never ad-hoc install dependencies; report a managed-runtime blocker explicitly.",
    zh: "anthropics-pdf：先探测 ReportLab，可导入时用于直接绘制型 PDF；旧运行时缺少它时，回落到结构化 DOCX/源文档经受管 LibreOffice 导出。确定性编辑使用 pypdf，非拉丁文字使用 LILY_CJK_FONT_PATH。禁止临时安装依赖；缺少受管运行时要明确报告。",
  }),
});

function buildSkillOverlaySection(enabledSkills, locale) {
  const zh = String(locale || "").startsWith("zh");
  const lines = (enabledSkills || [])
    .map((skill) => SKILL_PLATFORM_OVERLAYS[skill.id])
    .filter(Boolean)
    .map((overlay) => `- ${zh ? overlay.zh : overlay.en}`);
  if (!lines.length) return "";
  return ["## Tool Protocol Overrides", "", ...lines].join("\n");
}

module.exports = {
  SKILL_PLATFORM_OVERLAYS,
  buildSkillOverlaySection,
};
