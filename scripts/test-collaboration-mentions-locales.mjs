import assert from "node:assert/strict";
import fs from "node:fs";
const keys = ["action", "hint", "selected", "candidates", "remove", "close", "retry", "loading", "unknown", "failed", "noMatch", "results", "unavailable", "limit", "you", "count"];
for (const language of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${language}.json`, import.meta.url), "utf8"));
  for (const key of keys) assert.ok(messages[`collaboration.mentions.${key}`]?.trim(), `${language}: missing mentions.${key}`);
  assert.match(messages["collaboration.mentions.count"], /\{count\}/);
  assert.match(messages["collaboration.mentions.remove"], /\{name\}/);
  assert.match(messages["collaboration.mentions.hint"], /@/);
  assert.match(messages["collaboration.mentions.hint"].split(/[.。，،]/)[0], /@/, `${language}: selection limits @ reminders, not ordinary message notifications`);
}
const helper = fs.readFileSync(new URL("../src/renderer/modules/collaboration-mentions.js", import.meta.url), "utf8");
assert.doesNotMatch(helper, /innerHTML|insertAdjacentHTML|createContextualFragment|fetch\(|getDirectory|getTeam|getFriends/);
assert.ok(helper.split('\n').length <= 500, "picker helper remains bounded");
const css = fs.readFileSync(new URL("../src/renderer/styles/collaboration.css", import.meta.url), "utf8");
assert.match(css, /\.collaboration-mentions button:focus-visible/);
assert.match(css, /#collaborationMentionList[^{}]*\{[^}]*max-block-size:[^}]*overflow[^}]*auto/s);
assert.match(css, /\.collaboration-mention-tag[^{}]*\{[^}]*min-inline-size/s);
console.log("collaboration mention locale/plaintext/logical layout guards passed");
