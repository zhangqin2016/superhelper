import assert from "node:assert/strict";
import fs from "node:fs";

const keys = ["action", "clear", "preview", "revoked", "unavailable", "legacy", "attachment", "workspace", "empty", "truncated"];
for (const language of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${language}.json`, import.meta.url), "utf8"));
  for (const key of keys) {
    const text = messages[`collaboration.reply.${key}`];
    assert.ok(typeof text === "string" && text.trim() && !text.startsWith("collaboration."), `${language}: missing reply.${key}`);
  }
  assert.notEqual(messages["collaboration.reply.preview"], messages["collaboration.reply.action"], "draft preview explicitly differs from a sent quote");
  assert.ok(messages["collaboration.messageUnavailable"], `${language}: masked source has a translated unavailable placeholder`);
}
for (const module of ["collaboration-reply-view", "collaboration-timeline", "collaboration-composer"]) {
  const source = fs.readFileSync(new URL(`../src/renderer/modules/${module}.js`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|createContextualFragment/, `${module}: quote text cannot become markup`);
}
const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
assert.match(html, /id="collaborationReplyPreview"[^>]*hidden/, "production inline preview starts hidden");
const css = fs.readFileSync(new URL("../src/renderer/styles/collaboration.css", import.meta.url), "utf8");
assert.match(css, /\.collaboration-reply-quote[^{}]*\{[^}]*border-inline-start/s, "quote styling uses logical direction");
assert.match(css, /\[data-action="reply-message"\]:focus-visible/, "keyboard reply has a visible focus indicator");
console.log("collaboration reply locale, plaintext and logical-direction guards passed");
