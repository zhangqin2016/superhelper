"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ReportLab embeds TrueType glyph outlines only. A .ttc/.otf carrying
// PostScript (CFF) outlines raises
//   TTFError: postscript outlines are not supported
// so handing one to the Python runtime as LILY_CJK_FONT_PATH silently costs us
// every CJK character in a drawn PDF. macOS ships CFF for its two best CJK
// faces (PingFang, Hiragino Sans GB), and Linux ships CFF for Noto CJK, so
// "the font exists" was never a strong enough test. [gate: cjk-pdf-font]
const OUTLINE_TRUETYPE = "truetype";
const OUTLINE_POSTSCRIPT = "postscript";
const OUTLINE_UNKNOWN = "unknown";

const TTC_TAG = "ttcf";
const MAX_SFNT_TABLES = 512;

function platformFontCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const fonts = path.join(env.WINDIR || env.SystemRoot || "C:\\Windows", "Fonts");
    return ["msyh.ttc", "msyhbd.ttc", "simhei.ttf", "simsun.ttc"].map((name) => path.join(fonts, name));
  }
  if (platform === "darwin") {
    return [
      "/System/Library/Fonts/PingFang.ttc",
      "/System/Library/Fonts/Hiragino Sans GB.ttc",
      // Both of the above carry PostScript outlines. These two do not, and ship
      // on every supported macOS, so a drawn PDF keeps its Chinese text.
      "/System/Library/Fonts/STHeiti Light.ttc",
      "/System/Library/Fonts/STHeiti Medium.ttc",
      "/System/Library/Fonts/Supplemental/Songti.ttc",
    ];
  }
  return [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    // Noto CJK is PostScript-outlined in every common packaging; these are not.
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
  ];
}

/**
 * Which glyph outlines a font file carries, read from its sfnt table directory.
 * Returns OUTLINE_UNKNOWN for anything unreadable or unrecognized — callers must
 * treat that as "no opinion", never as a rejection.
 */
function readFontOutlineFormat(filePath, {
  openSync = fs.openSync,
  readSync = fs.readSync,
  closeSync = fs.closeSync,
} = {}) {
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const readAt = (position, length) => {
      const buffer = Buffer.alloc(length);
      return readSync(fd, buffer, 0, length, position) === length ? buffer : null;
    };

    // A TrueType Collection puts the first font's offset table somewhere else.
    let offsetTable = 0;
    const header = readAt(0, 16);
    if (!header) return OUTLINE_UNKNOWN;
    if (header.subarray(0, 4).toString("latin1") === TTC_TAG) {
      if (header.readUInt32BE(8) < 1) return OUTLINE_UNKNOWN;
      offsetTable = header.readUInt32BE(12);
    }

    const directory = readAt(offsetTable, 12);
    if (!directory) return OUTLINE_UNKNOWN;
    const tableCount = directory.readUInt16BE(4);
    if (tableCount < 1 || tableCount > MAX_SFNT_TABLES) return OUTLINE_UNKNOWN;
    const records = readAt(offsetTable + 12, tableCount * 16);
    if (!records) return OUTLINE_UNKNOWN;

    let truetype = false;
    let postscript = false;
    for (let index = 0; index < tableCount; index += 1) {
      const tag = records.subarray(index * 16, index * 16 + 4).toString("latin1");
      if (tag === "glyf") truetype = true;
      else if (tag === "CFF " || tag === "CFF2") postscript = true;
    }
    if (truetype) return OUTLINE_TRUETYPE;
    if (postscript) return OUTLINE_POSTSCRIPT;
    return OUTLINE_UNKNOWN;
  } catch {
    // Probing is an enhancement. An unreadable font must not block a turn.
    return OUTLINE_UNKNOWN;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Pick a CJK font the Python runtime can actually embed.
 *
 * Preference order is unchanged; what changed is that a candidate ReportLab
 * provably cannot embed is passed over. If NOTHING embeddable exists, the first
 * existing candidate is returned anyway — exactly what this function returned
 * before the probe existed — so the failure mode is never worse than baseline.
 *
 * @returns {{ path: string|null, outline: string, rejected: Array<{path: string, outline: string}> }}
 */
function resolveCjkFontChoice({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  readOutlineFormat = readFontOutlineFormat,
} = {}) {
  const configured = String(env.LILY_CJK_FONT_PATH || "").trim();
  // Dedupe: an explicit override is very often one of the system candidates, and
  // probing it twice would report it rejected twice.
  const candidates = [...new Set([configured, ...platformFontCandidates(platform, env)].filter(Boolean))];
  const rejected = [];
  let fallback = null;

  for (const candidate of candidates) {
    let present = false;
    try {
      present = existsSync(candidate);
    } catch {
      // Font discovery is an enhancement. A broken probe must not block turns.
      continue;
    }
    if (!present) continue;
    if (!fallback) fallback = candidate;

    let outline = OUTLINE_UNKNOWN;
    try {
      outline = readOutlineFormat(candidate);
    } catch {
      outline = OUTLINE_UNKNOWN;
    }
    if (outline === OUTLINE_POSTSCRIPT) {
      rejected.push({ path: candidate, outline });
      continue;
    }
    return { path: candidate, outline, rejected };
  }

  // Nothing embeddable. Keep the legacy answer rather than handing back nothing.
  return { path: fallback, outline: fallback ? OUTLINE_POSTSCRIPT : OUTLINE_UNKNOWN, rejected };
}

function resolveCjkFontPath(options = {}) {
  return resolveCjkFontChoice(options).path;
}

module.exports = {
  OUTLINE_POSTSCRIPT,
  OUTLINE_TRUETYPE,
  OUTLINE_UNKNOWN,
  platformFontCandidates,
  readFontOutlineFormat,
  resolveCjkFontChoice,
  resolveCjkFontPath,
};
