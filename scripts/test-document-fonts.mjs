#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { platformFontCandidates, resolveCjkFontPath } = require("../src/main/document-fonts.js");

const configured = path.resolve("fixtures", "fonts", "custom-cjk.ttf");
assert.equal(
  resolveCjkFontPath({
    env: { LILY_CJK_FONT_PATH: configured, WINDIR: "C:\\Windows" },
    platform: "win32",
    existsSync: (candidate) => candidate === configured,
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
  }),
  windowsCandidates[2],
  "an invalid override falls through to a system CJK font",
);

assert.equal(
  resolveCjkFontPath({ env: {}, platform: "linux", existsSync: () => false }),
  null,
  "font discovery fails open when no candidate exists",
);

console.log("document-fonts: ok");
