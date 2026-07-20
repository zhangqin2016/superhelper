"use strict";

const fs = require("node:fs");
const path = require("node:path");

function platformFontCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const fonts = path.join(env.WINDIR || env.SystemRoot || "C:\\Windows", "Fonts");
    return ["msyh.ttc", "msyhbd.ttc", "simhei.ttf", "simsun.ttc"].map((name) => path.join(fonts, name));
  }
  if (platform === "darwin") {
    return [
      "/System/Library/Fonts/PingFang.ttc",
      "/System/Library/Fonts/Hiragino Sans GB.ttc",
      "/System/Library/Fonts/Supplemental/Songti.ttc",
    ];
  }
  return [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  ];
}

function resolveCjkFontPath({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const configured = String(env.LILY_CJK_FONT_PATH || "").trim();
  const candidates = [configured, ...platformFontCandidates(platform, env)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Font discovery is an enhancement. A broken probe must not block turns.
    }
  }
  return null;
}

module.exports = {
  platformFontCandidates,
  resolveCjkFontPath,
};
