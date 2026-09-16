#!/usr/bin/env node
// CJK font selection for drawn PDFs. ReportLab embeds TrueType glyph outlines
// only; a PostScript/CFF font raises "postscript outlines are not supported",
// and macOS ships CFF for its two best CJK faces. Picking by existence alone
// therefore handed the Python runtime a font it could not embed, and every
// Chinese character in a drawn PDF was silently lost to the Helvetica fallback.
// Acceptance 2026-09-16 DEF-001. [gate: cjk-pdf-font]
// Run: node scripts/test-document-fonts.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OUTLINE_POSTSCRIPT,
  OUTLINE_TRUETYPE,
  OUTLINE_UNKNOWN,
  platformFontCandidates,
  readFontOutlineFormat,
  resolveCjkFontChoice,
  resolveCjkFontPath,
} = require("../src/main/document-fonts.js");

const configured = path.resolve("fixtures", "fonts", "custom-cjk.ttf");
assert.equal(
  resolveCjkFontPath({
    env: { LILY_CJK_FONT_PATH: configured, WINDIR: "C:\\Windows" },
    platform: "win32",
    existsSync: (candidate) => candidate === configured,
    readOutlineFormat: () => OUTLINE_TRUETYPE,
  }),
  configured,
  "a valid explicit font path has priority",
);

const windowsCandidates = platformFontCandidates("win32", { WINDIR: "D:\\Windows" });
assert.equal(windowsCandidates[0], path.join("D:\\Windows", "Fonts", "msyh.ttc"));
assert.equal(
  resolveCjkFontPath({
    env: { LILY_CJK_FONT_PATH: "Z:\\missing.ttf", WINDIR: "D:\\Windows" },
    platform: "win32",
    existsSync: (candidate) => candidate === windowsCandidates[2],
    readOutlineFormat: () => OUTLINE_TRUETYPE,
  }),
  windowsCandidates[2],
  "an invalid override falls through to a system CJK font",
);

assert.equal(
  resolveCjkFontPath({ env: {}, platform: "linux", existsSync: () => false }),
  null,
  "font discovery fails open when no candidate exists",
);

// The defect: an existing but unembeddable font is passed over for one that works.
const macCandidates = platformFontCandidates("darwin", {});
const hiragino = "/System/Library/Fonts/Hiragino Sans GB.ttc";
const stheiti = "/System/Library/Fonts/STHeiti Light.ttc";
assert.ok(macCandidates.includes(stheiti), "macOS must offer a TrueType-outlined CJK face");
const chosen = resolveCjkFontChoice({
  env: { LILY_CJK_FONT_PATH: hiragino },
  platform: "darwin",
  existsSync: (candidate) => candidate === hiragino || candidate === stheiti,
  readOutlineFormat: (candidate) => (candidate === hiragino ? OUTLINE_POSTSCRIPT : OUTLINE_TRUETYPE),
});
assert.equal(chosen.path, stheiti, "a PostScript-outlined font is passed over");
assert.equal(chosen.outline, OUTLINE_TRUETYPE);
assert.deepEqual(chosen.rejected, [{ path: hiragino, outline: OUTLINE_POSTSCRIPT }]);
assert.equal(chosen.rejected.length, 1, "an override that repeats a system candidate is probed once");

// Never worse than baseline: when NOTHING embeddable exists, the legacy answer
// (the first font that merely exists) is still returned rather than nothing.
const onlyPostscript = resolveCjkFontChoice({
  env: {},
  platform: "darwin",
  existsSync: (candidate) => candidate === hiragino,
  readOutlineFormat: () => OUTLINE_POSTSCRIPT,
});
assert.equal(onlyPostscript.path, hiragino, "a font we cannot verify an alternative for is still used");

// An unreadable probe is "no opinion", never a rejection.
assert.equal(
  resolveCjkFontPath({
    env: {},
    platform: "darwin",
    existsSync: (candidate) => candidate === macCandidates[0],
    readOutlineFormat: () => OUTLINE_UNKNOWN,
  }),
  macCandidates[0],
);
assert.equal(
  resolveCjkFontPath({
    env: {},
    platform: "darwin",
    existsSync: () => true,
    readOutlineFormat: () => { throw new Error("unreadable"); },
  }),
  macCandidates[0],
  "a throwing probe must not block font discovery",
);

// The probe reads real files correctly. Only assert on fonts this machine has.
assert.equal(readFontOutlineFormat("/definitely/not/a/font.ttc"), OUTLINE_UNKNOWN);
const realChecks = [[hiragino, OUTLINE_POSTSCRIPT], [stheiti, OUTLINE_TRUETYPE]];
let realChecked = 0;
for (const [fontPath, expected] of realChecks) {
  if (!fs.existsSync(fontPath)) continue;
  assert.equal(readFontOutlineFormat(fontPath), expected, `${fontPath} outline format`);
  realChecked += 1;
}

console.log(`document-fonts: ok (${realChecked} real font(s) probed)`);
