#!/usr/bin/env node
/**
 * The user's permission mode must reach the model.
 *
 * `permissionMode` used to drive tool auto-approval and runtime identity only,
 * and never appeared in the prompt. So a user who explicitly chose 全自主 still
 * got turns that ended by handing the decision back ("要我接着做前端还是先跑
 * 全量测试?"), sometimes with the model's own task list unfinished. Auto-
 * approving its tools does not help if it stops to ask.
 *
 * Additive by construction: only "full" gets a directive, so "ask" and "plan"
 * sessions are byte-identical to before, and an unknown mode gets nothing
 * rather than inheriting autonomy instructions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildAutonomyGuidance, AUTONOMY_I18N } = require("../src/main/agent-autonomy-guidance.js");

const LOCALES = ["zh-CN", "en", "ar"];

// --- only "full" is affected ---------------------------------------------

for (const mode of ["ask", "plan", "", null, undefined, "weird", "FULL"]) {
  assert.equal(
    buildAutonomyGuidance(mode, "zh-CN"),
    "",
    `mode ${JSON.stringify(mode)} must add nothing — anything but "full" keeps the previous behaviour`,
  );
}
// Stray whitespace around a real mode is still that mode; dropping autonomy
// over a space would be a silent downgrade of what the user chose.
assert.equal(buildAutonomyGuidance("full ", "zh-CN"), buildAutonomyGuidance("full", "zh-CN"), "whitespace must not disable autonomy");

// --- "full" says the things the screenshot failure needed ----------------

for (const locale of LOCALES) {
  const block = buildAutonomyGuidance("full", locale);
  assert.ok(block.trim(), `${locale}: full autonomy must produce a directive`);
  assert.match(block, /^## /, `${locale}: the block must be a titled section`);
  const bullets = block.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(bullets.length >= 4, `${locale}: expected the full rule set, got ${bullets.length} bullets`);
  assert.equal(
    new Set(bullets).size,
    bullets.length,
    `${locale}: duplicated bullets mean a copy-paste slip in the locale table`,
  );
}

// The three behaviours the field failure violated, keyed on locale-specific
// wording so a translation that drops one fails rather than passing silently.
const REQUIRED = {
  "zh-CN": [/不要把选择权交回/, /不要以提问结束|不要用.{0,6}要我做/, /清单.{0,8}没做完|还有未完成项/, /不可逆/],
  en: [/do not hand the choice back/i, /do not end on a question/i, /unfinished|open items/i, /irreversible/i],
  ar: [/لا تُعِد الاختيار/, /لا تنتهِ بسؤال/, /غير مكتملة|بنوداً مفتوحة/, /لا رجعة/],
};
for (const [locale, patterns] of Object.entries(REQUIRED)) {
  const block = buildAutonomyGuidance("full", locale);
  for (const pattern of patterns) {
    assert.match(block, pattern, `${locale}: the directive must still carry ${pattern}`);
  }
}

// --- locale fallback is English, never Chinese ---------------------------

const unknown = buildAutonomyGuidance("full", "pt-BR");
assert.equal(unknown, buildAutonomyGuidance("full", "en"), "an unlisted locale must fall back to English");
assert.doesNotMatch(unknown, /[一-鿿]/, "an unlisted locale must never receive Chinese text");
assert.equal(buildAutonomyGuidance("full", "zh-TW"), buildAutonomyGuidance("full", "zh-CN"), "zh variants resolve to zh-CN");
assert.deepEqual(Object.keys(AUTONOMY_I18N).sort(), LOCALES.slice().sort(), "the locale table must cover exactly the shipped locales");

// --- actually wired into the per-prompt guidance -------------------------

const runner = fs.readFileSync(path.join(ROOT, "src/main/session-runner-pool.js"), "utf8");
assert.match(runner, /buildAutonomyGuidance\(permissionMode,/, "the runner must pass the session's real permission mode");
assert.match(runner, /if \(autonomy\) guidance \+= /, "the block must be appended to the per-prompt guidance");
// Must be fail-open: a throw here would take down every turn.
const wiring = runner.slice(runner.indexOf("agent-autonomy-guidance"));
assert.match(
  wiring.slice(0, 600),
  /catch\s*\{/,
  "the wiring must be fail-open — a failure here must leave guidance as before, not break the turn",
);

console.log("agent autonomy guidance: ok");
for (const locale of LOCALES) {
  const bytes = Buffer.byteLength(buildAutonomyGuidance("full", locale), "utf8");
  console.log(`  ${locale}: ${bytes}B appended in full-autonomy sessions, 0B in ask/plan`);
}
