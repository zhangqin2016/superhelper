#!/usr/bin/env node
// The public help center (/docs) is for end users, in all three languages.
//
// 2026-09-30: /docs was English-only on the Chinese site and described
// operator procedures (upload installers to Qiniu, create a license in the
// admin console, release metadata). This holds the rewrite:
//   - zh / en / ar carry the same shape (same section ids, block types and
//     list lengths), so no locale silently drops a section;
//   - no internal/operator terms reach any locale;
//   - no promise stronger than the legal pages ("fully offline", "files are
//     never uploaded"), and the privacy section links the legal documents;
//   - every section id is reachable from the section nav, which is built from
//     the same list the article renders.
// The catalog copy module is held to the same key parity.
import assert from "node:assert/strict";
import fs from "node:fs";

const { docsCopy, docsCopyFor } = await import("../web/lib/site-copy-docs.mjs");
const { catalogCopy, groupReleases } = await import("../web/lib/site-copy-catalog.mjs");

const HAN = /[㐀-鿿]/;

function shape(value) {
  if (typeof value === "string") return "s";
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, key === "type" || key === "id" || key === "href" ? value[key] : shape(value[key])]));
  }
  return typeof value;
}

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, out));
  return out;
}

// 1. Same shape in every locale.
for (const locale of ["en", "ar"]) {
  assert.deepEqual(shape(docsCopy[locale]), shape(docsCopy.zh), `docs copy: ${locale} must mirror zh exactly (ids, block types, list lengths)`);
  assert.deepEqual(shape(catalogCopy[locale]), shape(catalogCopy.zh), `catalog copy: ${locale} must mirror zh keys`);
  const leaks = strings(docsCopy[locale]).filter((text) => HAN.test(text));
  assert.deepEqual(leaks, [], `docs ${locale} must not contain Chinese text`);
  const catalogLeaks = strings(catalogCopy[locale]).filter((text) => HAN.test(text));
  assert.deepEqual(catalogLeaks, [], `catalog ${locale} must not contain Chinese text`);
}
assert.equal(docsCopyFor("xx"), docsCopy.zh, "unknown locale falls back to zh");

// 2. The sections the help center promises, anchored.
const REQUIRED = ["install", "account", "workspace", "delivery", "apps-skills", "enterprise", "updates", "privacy", "support"];
const ids = docsCopy.zh.sections.map((section) => section.id);
assert.deepEqual(ids, REQUIRED, "help center sections, in order");
assert.equal(new Set(ids).size, ids.length, "section ids are unique");
for (const id of ids) assert.match(id, /^[a-z][a-z-]*$/, `anchor-safe id: ${id}`);

// 3. No operator or internal procedure reaches the public help, in any locale.
const INTERNAL = [/七牛/, /qiniu/i, /admin console/i, /管理后台创建授权/, /latest\.json/i, /发布元数据/, /release metadata/i, /Service API URL/i, /license id/i];
// 4. No promise stronger than the legal pages.
const FORBIDDEN = [/完全离线/, /文件永不上传/, /never sent/i, /fully offline/i, /never (be )?uploaded/i, /不会上传任何/];
for (const locale of ["zh", "en", "ar"]) {
  const all = strings(docsCopy[locale]).join("\n");
  for (const pattern of INTERNAL) assert.doesNotMatch(all, pattern, `docs ${locale} leaks internal term ${pattern}`);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(all, pattern, `docs ${locale} over-promises: ${pattern}`);
  const privacy = docsCopy[locale].sections.find((section) => section.id === "privacy");
  const hrefs = privacy.links.map((link) => link.href);
  assert.ok(hrefs.includes("/legal/data-and-third-parties"), `${locale} privacy links the third-party list`);
  assert.ok(hrefs.includes("/privacy"), `${locale} privacy links the privacy policy`);
}
// The zh privacy answers say what IS sent (the privacy policy's own claim),
// rather than implying nothing leaves the machine.
const zhPrivacy = strings(docsCopy.zh.sections.find((section) => section.id === "privacy")).join("\n");
assert.match(zhPrivacy, /发送到你选择的模型服务/, "zh privacy states that prompts and needed content go to the chosen model service");

// 5. The enterprise facts shipped 2026-09-30 are all explained.
const zhEnterprise = strings(docsCopy.zh.sections.find((section) => section.id === "enterprise")).join("\n");
for (const fact of ["设置 → 账户", "只使用该企业的额度池", "只使用你的个人额度", "第一次使用", "7 天", "冻结", "暂停", "移出", "待加入", "一次性密码", "变更历史"]) {
  assert.ok(zhEnterprise.includes(fact), `zh enterprise section explains: ${fact}`);
}
const zhAccount = strings(docsCopy.zh.sections.find((section) => section.id === "account")).join("\n");
for (const fact of ["验证码", "登录名", "一次性密码", "设置新密码", "免费体验"]) assert.ok(zhAccount.includes(fact), `zh account section explains: ${fact}`);

// 6. The page renders the nav from the same section list it renders, and the
//    nav links every section by #id (desktop list and phone disclosure).
const page = fs.readFileSync(new URL("../web/app/docs/page.js", import.meta.url), "utf8");
const toc = fs.readFileSync(new URL("../web/app/docs/docs-toc.js", import.meta.url), "utf8");
assert.match(page, /const nav = copy\.sections\.map\(\(\{ id, title \}\) => \(\{ id, title \}\)\)/, "nav is derived from copy.sections");
assert.match(page, /<DocsToc items=\{nav\}/, "the derived list feeds the nav");
assert.match(page, /id=\{section\.id\}/, "each section carries its anchor id");
assert.match(toc, /href=\{`#\$\{item\.id\}`\}/, "nav links by #id");
assert.match(toc, /className="hd-aside"/, "desktop sticky nav");
assert.match(toc, /<details className="hd-mobile-nav"/, "collapsible nav on phones");
assert.doesNotMatch(page, /Upload installers|Create a license|admin console/i, "no operator copy left in the page source");
assert.match(page, /docsCopyFor\(locale\)/, "the page is localized");

// 7. Changelog grouping: one entry per version, newest first, platforms merged.
const grouped = groupReleases([
  { version: "0.1.9", platform: "win32-x64", notes: "旧版", createdAt: "2026-09-01T00:00:00Z" },
  { version: "0.1.10", platform: "win32-x64", notes: "甲；乙\n丙", force: true, createdAt: "2026-09-02T00:00:00Z" },
  { version: "0.1.10", platform: "darwin-arm64", notes: "甲；乙\n丙", createdAt: "2026-09-02T00:00:01Z" },
]);
assert.deepEqual(grouped.map((entry) => entry.version), ["0.1.10", "0.1.9"], "semantic order, not string order");
assert.deepEqual(grouped[0].platforms, ["darwin-arm64", "win32-x64"]);
assert.deepEqual(grouped[0].highlights, ["甲", "乙", "丙"]);
assert.equal(grouped[0].force, true);

// 8. Contact keeps the server contract; the topic rides in `subject`.
const form = fs.readFileSync(new URL("../web/components/contact-form.js", import.meta.url), "utf8");
const contactPage = fs.readFileSync(new URL("../web/app/contact/page.js", import.meta.url), "utf8");
assert.match(form, /fetch\("\/api\/contact-requests"/);
assert.doesNotMatch(form, /topic: /, "no new field in the payload");
assert.match(contactPage, /params\?\.topic/, "?topic= preselects a topic");
assert.ok(catalogCopy.zh.contact.topics.enterprise, "an enterprise topic exists");
assert.doesNotMatch(contactPage, /admin\/login/, "the public contact page does not send visitors to the operator console");

console.log("site docs: ok");
