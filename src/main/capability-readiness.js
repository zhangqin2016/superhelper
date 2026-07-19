"use strict";

const path = require("node:path");

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function fileExtensions(files = []) {
  return new Set((Array.isArray(files) ? files : []).map((file) => (
    path.extname(String(file?.name || file?.path || "")).toLowerCase()
  )));
}

function planCapabilityReadiness({ text = "", files = [], intentContract = null, turnPolicy = null } = {}) {
  const body = String(text || "");
  const extensions = fileExtensions(files);
  const browser = /localhost|截图|控制台|浏览器|playwright|browser|responsive|响应式/i.test(body);
  const pdf = extensions.has(".pdf") || /\bpdf\b/i.test(body);
  const complexPdf = pdf && /复杂|版面|阅读顺序|表格结构|layout|reading order|table structure/i.test(body);
  const mediaFile = [...extensions].some((ext) => [
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
    ".mp4", ".mov", ".mkv", ".avi", ".webm",
  ].includes(ext));
  const mediaTransform = /转码|转换视频|裁剪视频|压缩视频|提取音频|合并音频|合并视频|ffmpeg|transcode|convert video|trim video|compress video|extract audio/i.test(body);
  const media = mediaTransform || (mediaFile && /转换|转码|裁剪|压缩|合并|提取|convert|trim|compress|merge|extract/i.test(body));

  const baseline = {
    capabilityIds: unique([
      browser ? "browser-qa" : "",
      pdf ? "pdf-read" : "",
      complexPdf ? "pdf-layout" : "",
      media ? "media-transform" : "",
    ]),
    requiredPackIds: unique([
      browser ? "web-automation" : "",
      complexPdf ? "pro-pdf" : "",
      media ? "ffmpeg" : "",
    ]),
    enhancementPackIds: unique([
      pdf ? "large-document" : "",
      pdf && !complexPdf ? "pro-pdf" : "",
    ]),
    fallbackCapabilityIds: unique([
      browser ? "code-static-review" : "",
      pdf ? "bundled-pdf-extraction" : "",
      media ? "media-source-inspection" : "",
    ]),
  };

  try {
    const { recommendSkillCapabilityGraph } = require("./capability-broker");
    const { PACK_SPECS } = require("./runtime-pack-specs");
    const recommended = recommendSkillCapabilityGraph({ text, files, turnPolicy, maxSkills: 8 });
    const explicitPackIds = (intentContract?.neededCapabilities || []).filter((id) => PACK_SPECS[id]);
    const recommendedPackIds = recommended.flatMap((skill) => skill.requiredRuntimePacks || []);
    return {
      capabilityIds: unique([
        ...baseline.capabilityIds,
        ...(intentContract?.neededCapabilities || []),
        ...recommended.map((skill) => skill.id),
      ]),
      requiredPackIds: unique([
        ...baseline.requiredPackIds,
        ...explicitPackIds,
      ]),
      enhancementPackIds: unique([
        ...baseline.enhancementPackIds,
        ...recommendedPackIds.filter((id) => !baseline.requiredPackIds.includes(id) && !explicitPackIds.includes(id)),
      ]),
      fallbackCapabilityIds: unique([
        ...baseline.fallbackCapabilityIds,
        ...recommended.flatMap((skill) => String(skill.failOpen || "").split(",")),
      ]),
      recommendedSkillIds: recommended.map((skill) => skill.id),
      source: recommended.length ? "intent_and_catalog" : "baseline",
    };
  } catch {
    return { ...baseline, recommendedSkillIds: [], source: "baseline" };
  }
}

function resolveCapabilityReadiness(plan = {}, state = {}) {
  const installed = state.installedPackIds instanceof Set ? state.installedPackIds : new Set();
  const installing = state.installingPackIds instanceof Set ? state.installingPackIds : new Set();
  const unavailable = state.unavailablePackIds instanceof Set ? state.unavailablePackIds : new Set();
  const required = unique(plan.requiredPackIds);
  const enhancements = unique(plan.enhancementPackIds);
  const unavailablePackIds = required.filter((id) => unavailable.has(id));
  const installingPackIds = required.filter((id) => !installed.has(id) && installing.has(id));
  const missingRequiredPackIds = required.filter((id) => (
    !installed.has(id) && !installing.has(id) && !unavailable.has(id)
  ));
  const missingEnhancementPackIds = enhancements.filter((id) => !installed.has(id));
  const status = unavailablePackIds.length
    ? "degraded"
    : missingRequiredPackIds.length || installingPackIds.length
      ? "preparing"
      : "ready";

  return {
    status,
    readyPackIds: required.filter((id) => installed.has(id)),
    missingRequiredPackIds,
    missingEnhancementPackIds,
    installingPackIds,
    unavailablePackIds,
    refreshRequired: missingRequiredPackIds.length > 0 || installingPackIds.length > 0,
  };
}

module.exports = {
  planCapabilityReadiness,
  resolveCapabilityReadiness,
};
