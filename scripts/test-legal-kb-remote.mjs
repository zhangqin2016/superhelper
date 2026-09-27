#!/usr/bin/env node
/**
 * lily_legal_search / lily_legal_article read the served legal corpus.
 *
 * The request carries what the server's retrieval needs (query, the laws the
 * agent judged to govern, the device id the signature covers); results come
 * back as whole articles with their law's validity and a citation line; and an
 * unreachable, unauthorized or rate-limited service fails open — ok:false, no
 * results — so the model is told the evidence is missing.
 * Run: node scripts/test-legal-kb-remote.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { searchLegalKnowledgeRemote, getLegalArticleRemote, toolArticle } = require("../src/main/legal-kb/legal-kb-remote.js");

{
  const mapped = toolArticle({ id: "法律/劳动合同法.md#第三十九条@7", law: "劳动合同法", title: "中华人民共和国劳动合同法", article: "第三十九条",
    text: "劳动者有下列情形之一的，用人单位可以解除劳动合同：…", category: "法律", authority: "全国人民代表大会常务委员会",
    promulgatedAt: "2012-12-28", effectiveAt: "2013-07-01", validity: "effective", lawSource: "caller" });
  assert.equal(mapped.citation, "《中华人民共和国劳动合同法》第三十九条", "a citation line the answer can use as is");
  assert.equal(mapped.validity, "effective");
  assert.equal(toolArticle({ title: "某法", article: "第一条" }).validity, "unknown", "an unknown validity is said, not assumed");
}

{
  const calls = [];
  const serviceFetch = async (path, init) => { calls.push({ path, body: JSON.parse(init.body) }); return { ok: true, json: {
    corpusVersion: "V28", laws: [{ name: "劳动合同法", source: "caller" }],
    results: [{ id: "a#第二十四条@3", law: "劳动合同法", title: "中华人民共和国劳动合同法", article: "第二十四条", text: "竞业限制期限，不得超过二年。", validity: "effective" }],
  } }; };
  const out = await searchLegalKnowledgeRemote({ query: "  竞业限制 期限 ", laws: ["劳动合同法", " "], topK: 99, serviceFetch, getDeviceId: () => "device-1" });
  assert.deepEqual(calls[0], { path: "/api/legal/search", body: { query: "竞业限制 期限", topK: 20, laws: ["劳动合同法"], deviceId: "device-1" } },
    "query compacted, topK bounded, empty law names dropped, the device id the signature covers");
  assert.deepEqual([out.ok, out.source, out.corpusVersion, out.results[0].citation], [true, "service", "V28", "《中华人民共和国劳动合同法》第二十四条"]);
  const article = await getLegalArticleRemote({ law: "劳动合同法", article: "第24条", serviceFetch, getDeviceId: () => "device-1" });
  assert.deepEqual(calls[1], { path: "/api/legal/article", body: { law: "劳动合同法", article: "第24条", deviceId: "device-1" } });
  assert.equal(article.ok, true);
  assert.equal((await getLegalArticleRemote({ serviceFetch })).error, "LEGAL_ARTICLE_REFERENCE_REQUIRED");
}

{
  assert.equal((await searchLegalKnowledgeRemote({ query: " " })).error, "LEGAL_KB_QUERY_REQUIRED");
  assert.equal((await searchLegalKnowledgeRemote({ query: "x".repeat(241) })).error, "LEGAL_KB_QUERY_TOO_LONG");
  const refused = await searchLegalKnowledgeRemote({ query: "竞业限制", serviceFetch: async () => ({ ok: false, error: "LEGAL_KB_NOT_ENTITLED", status: 403 }) });
  assert.deepEqual([refused.ok, refused.error, refused.results], [false, "LEGAL_KB_NOT_ENTITLED", []], "a refusal names its reason and returns nothing to cite");
  const limited = await searchLegalKnowledgeRemote({ query: "竞业限制", serviceFetch: async () => ({ ok: false, error: "LEGAL_SEARCH_RATE_LIMITED", status: 429 }) });
  assert.equal(limited.error, "LEGAL_SEARCH_RATE_LIMITED");
  const down = await searchLegalKnowledgeRemote({ query: "竞业限制", serviceFetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual([down.ok, down.error, down.results], [false, "LEGAL_KB_SERVICE_UNAVAILABLE", []], "a network failure never throws into the turn");
}

console.log("legal-kb-remote: ok");

// The local pack an earlier version downloaded is retired, once, and only Lily's own directory.
{
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const retirement = require("../src/main/legal-kb/local-pack-retirement.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lily-retire-"));
  const root = path.join(base, "legal-kb");
  fs.mkdirSync(path.join(root, "legal-cn-enterprise", "V23.3"), { recursive: true });
  fs.writeFileSync(path.join(root, "legal-cn-enterprise", "V23.3", "legal.sqlite"), "x");
  const quiet = { info() {}, warn() {} };
  assert.deepEqual(await retirement.retireLocalLegalPack({ root, log: quiet }), { ok: true, removed: true });
  assert.equal(fs.existsSync(root), false, "the retired pack is gone");
  retirement.resetForTests();
  const other = path.join(base, "not-legal");
  fs.mkdirSync(other);
  assert.deepEqual(await retirement.retireLocalLegalPack({ root: other, log: quiet }), { ok: true, removed: false });
  assert.equal(fs.existsSync(other), true, "a directory that is not Lily's legal-kb is never removed");
  fs.rmSync(base, { recursive: true, force: true });
  console.log("legal-kb-remote: local pack retirement ok");
}
