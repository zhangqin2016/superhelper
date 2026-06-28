#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const CACHE = path.join(os.homedir(), ".lily", "video-creation");
const PLAT = process.platform === "darwin" ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
  : process.platform === "win32" ? "win32-x64" : "linux-x64";
const EXE = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

// Default source = ffmpeg-static GitHub release (stable, per-platform static builds,
// ~45MB each, single self-contained binary). Override with LILY_FFMPEG_URL to point
// at your own CDN (e.g. Qiniu) if you prefer not to hit GitHub.
const FF_TAG = "b6.1.1";
const FF_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/" + FF_TAG;
const FFMPEG_URLS = {
  "darwin-arm64": process.env.LILY_FFMPEG_URL || FF_BASE + "/ffmpeg-darwin-arm64",
  "darwin-x64": process.env.LILY_FFMPEG_URL || FF_BASE + "/ffmpeg-darwin-x64",
  "win32-x64": process.env.LILY_FFMPEG_URL || FF_BASE + "/ffmpeg-win32-x64",
  "linux-x64": process.env.LILY_FFMPEG_URL || FF_BASE + "/ffmpeg-linux-x64",
};
const FONT_URL = process.env.LILY_FONT_URL || ""; // optional CJK font; system fonts preferred (see below)
// System CJK fonts present on most machines — preferred over downloading anything.
const SYSTEM_CJK_FONTS = {
  darwin: ["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc", "/Library/Fonts/Arial Unicode.ttf"],
  win32: ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyh.ttf", "C:/Windows/Fonts/simhei.ttf"],
  linux: ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"],
};

function works(bin) {
  try { return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; }
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const f = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        f.close(); fs.rmSync(dest, { force: true }); return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) { f.close(); fs.rmSync(dest, { force: true }); return reject(new Error("HTTP " + res.statusCode)); }
      res.pipe(f); f.on("finish", () => f.close(() => resolve(dest)));
    }).on("error", (e) => { f.close(); fs.rmSync(dest, { force: true }); reject(e); });
  });
}

async function ensureFfmpeg() {
  if (process.env.FFMPEG_BIN && works(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  const cached = path.join(CACHE, "bin", EXE);
  if (works(cached)) return cached;
  if (works("ffmpeg")) return "ffmpeg"; // system install
  const url = FFMPEG_URLS[PLAT];
  if (!url) throw new Error("未找到 ffmpeg,且未配置下载源(LILY_FFMPEG_URL)。请安装 ffmpeg 或配置 CDN。");
  await download(url, cached);
  if (process.platform !== "win32") fs.chmodSync(cached, 0o755);
  if (!works(cached)) throw new Error("下载的 ffmpeg 无法运行。");
  return cached;
}

async function ensureFont() {
  if (process.env.SUBTITLE_FONT && fs.existsSync(process.env.SUBTITLE_FONT)) return process.env.SUBTITLE_FONT;
  // Prefer a system CJK font — no download, present on most macOS/Windows machines.
  for (const f of (SYSTEM_CJK_FONTS[process.platform] || [])) { if (fs.existsSync(f)) return f; }
  const cached = path.join(CACHE, "fonts", "subtitle.otf");
  if (fs.existsSync(cached)) return cached;
  if (!FONT_URL) return ""; // optional — subtitles fail-open if absent
  try { await download(FONT_URL, cached); return cached; } catch { return ""; }
}

(async () => {
  try {
    const ffmpeg = await ensureFfmpeg();
    const font = await ensureFont();
    process.stdout.write(JSON.stringify({ ffmpeg, font }) + "\n");
  } catch (e) {
    process.stderr.write("[setup-ffmpeg] " + (e && e.message || e) + "\n");
    process.exit(1);
  }
})();
