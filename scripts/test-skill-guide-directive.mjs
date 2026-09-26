#!/usr/bin/env node
/**
 * The router's best match is an instruction the model may decline — read the
 * guide completely before acting, or say why it does not fit — never the
 * guide's body forced into the turn (the router misfires even at high scores).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const broker = require("../src/main/capability-broker.js");
const { bestMatchDirective, DIRECTIVE_MIN_SCORE } = require("../src/main/skill-guide-directive.js");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };
const directiveLine = (text, extra = {}) => broker.compactCapabilityContext({ text, maxChars: 4000, ...extra }).split("\n").find((line) => line.startsWith("Best match for this request:")) || "";

{
  // The field turn (2026-09-26): 5 relevant guides recommended, none read.
  const line = directiveLine("生成个精美pdf");
  assert.match(line, /^Best match for this request: anthropics-pdf\./);
  assert.match(line, /read its guide completely: \/.+SKILL\.md\./, "names an absolute guide path to read");
  assert.match(line, /If it does not fit this request, say why in one short line and continue\./, "and lets the model decline with a reason");
  check("a rule-level match becomes an instruction to read its guide, or say why not");
}

{
  // A real turn that matched a keyword hint only (browser-qa at 60).
  const hint = "我要让你用 anjaz系统去测试我们平台";
  const top = broker.rankSkillCapabilityGraph({ text: hint, maxSkills: 1 })[0];
  assert.ok(top && top.score > 0 && top.score < DIRECTIVE_MIN_SCORE, "a keyword-hint match is recommended, below the rule level");
  assert.equal(directiveLine(hint), "", "and gets no directive");
  assert.equal(directiveLine("hi"), "", "a greeting gets none");
  check("keyword-hint matches and chat stay a plain listing");
}

{
  const text = broker.compactCapabilityContext({ text: "生成个精美pdf", maxChars: 4000 });
  const fs = require("node:fs");
  const top = broker.rankSkillCapabilityGraph({ text: "生成个精美pdf", maxSkills: 1 })[0];
  const body = fs.readFileSync(top.skill.guidePath, "utf8").replace(/^---[\s\S]*?---\s*/, "").split("\n").find((line) => line.trim().length > 40);
  assert.ok(body && !text.includes(body.trim()), "the guide's body never rides the turn");
  check("the guide is named, not injected");
}

{
  assert.deepEqual(bestMatchDirective({ text: "生成个精美pdf" }, [{ id: "some-other-skill" }]), [], "a best match not in the listing is not singled out");
  process.env.LILY_SKILL_BEST_MATCH_DIRECTIVE = "0";
  assert.equal(directiveLine("生成个精美pdf"), "", "LILY_SKILL_BEST_MATCH_DIRECTIVE=0 restores the listing alone");
  delete process.env.LILY_SKILL_BEST_MATCH_DIRECTIVE;
  check("only a listed best match, and the kill switch holds");
}

{
  // The directive is extra: it never pushes out what the listing kept.
  const routes = () => broker.compactCapabilityContext({ text: "生成个精美pdf", maxChars: 1800 }).split("\n").filter((line) => /^- [a-z]+\.[a-z_]+:/.test(line) || /^- [a-z]+-[a-z-]+ \[/.test(line)).map((line) => line.split(/[: ]/)[1]);
  const withDirective = routes();
  process.env.LILY_SKILL_BEST_MATCH_DIRECTIVE = "0";
  const without = routes();
  delete process.env.LILY_SKILL_BEST_MATCH_DIRECTIVE;
  assert.deepEqual(withDirective, without, "every skill and route line kept without the directive is kept with it");
  check("the directive adds to the budget instead of displacing a route");
}

{
  // Codex's accountability rule rides every prompt's capability catalog, in
  // every guide language: name the guide you follow, explain a skipped match.
  const { SKILL_INDEX_I18N } = require("../src/main/agent-guide-index.js");
  assert.match(SKILL_INDEX_I18N["zh-CN"].intro, /动手时一句话说明所用指南；明显匹配却不用须说明原因/);
  assert.match(SKILL_INDEX_I18N.en.intro, /name the guide you follow in one line; if you skip a clearly matching one, say why/);
  assert.match(SKILL_INDEX_I18N.ar.intro, /اذكر في سطر الدليل الذي تتبعه/);
  for (const loc of ["zh-CN", "en", "ar"]) assert.match(SKILL_INDEX_I18N[loc].intro, /最终答案|final answer|الإجابة النهائية/, `${loc}: kept out of the final answer`);
  check("the catalog asks every model to name its guide or explain skipping it, in all three languages");
}

console.log(`skill-guide-directive: ok (${checks} checks)`);
