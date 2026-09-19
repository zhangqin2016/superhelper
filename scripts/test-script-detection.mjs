#!/usr/bin/env node
// Which writing system a text is in has one definition, for both processes.
//
// Before 2026-09-19 seventeen sites spelled their own Han character class,
// seven different ways, and two modules kept identical copies of
// answerLanguage(): one sentence could be Chinese to the answer language, not
// Chinese to the scope note, and half-Chinese to the token estimate.
// [gate: script-detection-single-definition]
// Run: node scripts/test-script-detection.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as script from "../src/shared/script.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("Han covers Extension A, the unified block and the compatibility block — and nothing else", () => {
  for (const ch of ["㐀", "䶿", "一", "鿿", "豈", "﫿", "中"]) assert.equal(script.hasHan(ch), true, `U+${ch.codePointAt(0).toString(16)}`);
  for (const ch of ["぀", "ヿ", "가", "a", "1", "　", "！"]) assert.equal(script.hasHan(ch), false, `U+${ch.codePointAt(0).toString(16)} is not Han`);
  assert.equal(script.EAST_ASIAN_CHAR_RE.test("カタカナ"), true, "kana counts as East Asian text");
  assert.equal(script.hanCount("中文 abc 字"), 3);
  assert.deepEqual(script.hanChars("a中b文"), ["中", "文"]);
  // The ranges are escapes, not literal characters, so no normalising editor
  // can silently turn U+F900 into U+8C48 and widen the class to half of Unicode.
  const src = fs.readFileSync(path.join(ROOT, "src/shared/script.mjs"), "utf8");
  assert.match(src, /HAN_RANGES = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff"/);
});

check("one answer language, one instruction language", () => {
  assert.equal(script.answerLanguage("请总结这份报告"), "zh");
  assert.equal(script.answerLanguage("لخّص هذا التقرير"), "ar");
  assert.equal(script.answerLanguage("summarise this report"), "en");
  assert.equal(script.answerLanguage(""), "en");
  assert.equal(script.instructionLanguage({ instructionLanguage: "zh" }), "zh");
  assert.equal(script.instructionLanguage({ instructionLanguage: "en" }), "en");
  assert.equal(script.instructionLanguage(null), "en");
  const viaRequire = require("../src/shared/script.mjs");
  assert.equal(viaRequire.answerLanguage, script.answerLanguage, "the main process reads the same definition");
});

check("no module spells a Han character class or the instruction-language check on its own", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full);
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (/\\u4e00-\\u9fff|\\u3400-\\u9fff|\\u3400-\\u4dbf|一-鿿|㐀-䶿/.test(code)) offenders.push(`${rel}: Han class`);
      if (/instructionLanguage === "zh"/.test(code)) offenders.push(`${rel}: instruction language`);
      if (/^function answerLanguage\(/m.test(code)) offenders.push(`${rel}: answerLanguage copy`);
    }
  };
  walk(path.join(ROOT, "src/main"));
  walk(path.join(ROOT, "src/renderer"));
  assert.deepEqual(offenders, [], `writing systems are decided in src/shared/script.mjs:\n${offenders.join("\n")}`);
});

console.log(`\n${checks} checks passed (script detection)`);
