#!/usr/bin/env node
/**
 * Legal retrieval finds the governing law, then the article inside it.
 *
 * Production measurement (deploy/legal-kb/eval-gateway.cjs, 25 plain-language
 * questions): the V2 service alone put the answering article in the top 5 for
 * 7 (lexical) and 8 (semantic); the gateway 21 without a law hint and 24 with
 * the law named by the agent. This test pins the mechanism on a fixture pack
 * in the corpus's own format.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { LegalCorpus, searchLegal, getArticle, articleLabel, intToChinese, baseTitle } = require("../deploy/legal-kb/gateway/legal-retrieval.cjs");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-legal-pack-"));

try {
  // ------------------------------------------------ a pack in the V27 format
  const docs = [
    { title: "中华人民共和国劳动合同法", sourcePath: "法律/劳动合同法2012.md", category: "法律", promulgatedAt: "2012-12-28", effectiveAt: "2013-07-01" },
    { title: "中华人民共和国劳动合同法", sourcePath: "法律/劳动合同法2007.md", category: "法律", promulgatedAt: "2007-06-29", effectiveAt: "2008-01-01" },
    { title: "中华人民共和国民法典·合同编", sourcePath: "法律/民法典合同编.md", category: "法律", promulgatedAt: "2020-05-28", effectiveAt: "2021-01-01" },
    { title: "中华人民共和国民事诉讼法", sourcePath: "法律/民事诉讼法.md", category: "法律", promulgatedAt: "2023-09-01", effectiveAt: "2024-01-01" },
    { title: "某省劳动合同条例", sourcePath: "地方/某省劳动合同条例.md", category: "地方性法规", promulgatedAt: "2019-01-01", effectiveAt: "2019-03-01" },
    { title: "中华人民共和国合同法", sourcePath: "法律/合同法1999.md", category: "法律", promulgatedAt: "1999-03-15", effectiveAt: "1999-10-01" },
  ];
  const rows = [
    ["法律/劳动合同法2012.md", "中华人民共和国劳动合同法", "题注", "（2007年6月29日通过 2012年12月28日修正）"],
    ["法律/劳动合同法2012.md", "中华人民共和国劳动合同法", "第一条", "为了完善劳动合同制度，明确劳动合同双方当事人的权利和义务，保护劳动者的合法权益，制定本法。"],
    ["法律/劳动合同法2012.md", "中华人民共和国劳动合同法", "第二十四条", "竞业限制的人员限于用人单位的高级管理人员、高级技术人员和其他负有保密义务的人员。在解除或者终止劳动合同后，前款规定的人员到与本单位生产或者经营同类产品、从事同类业务的有竞争关系的其他用人单位，竞业限制期限，不得超过二年。"],
    ["法律/劳动合同法2012.md", "中华人民共和国劳动合同法", "第三十九条", "劳动者有下列情形之一的，用人单位可以解除劳动合同：（一）在试用期间被证明不符合录用条件的；（二）严重违反用人单位的规章制度的；"],
    ["法律/劳动合同法2012.md", "中华人民共和国劳动合同法", "第四十一条", "有下列情形之一，需要裁减人员二十人以上或者裁减不足二十人但占企业职工总数百分之十以上的，用人单位提前三十日向工会或者全体职工说明情况，可以裁减人员。"],
    ["法律/劳动合同法2007.md", "中华人民共和国劳动合同法", "第三十九条", "（2007 年文本）劳动者严重违反用人单位的规章制度的，用人单位可以解除劳动合同。"],
    ["法律/民法典合同编.md", "中华人民共和国民法典·合同编", "第五百八十五条", "约定的违约金过分高于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以适当减少。"],
    ["法律/民事诉讼法.md", "中华人民共和国民事诉讼法", "第一百一十九条", "起诉必须符合下列条件。"],
    ["地方/某省劳动合同条例.md", "某省劳动合同条例", "第一条", "为了规范劳动合同，根据《中华人民共和国劳动合同法》，结合本省实际，制定本条例。用人单位 解除 劳动合同 规章制度"],
    ["法律/合同法1999.md", "中华人民共和国合同法", "第一百一十四条", "约定的违约金过分高于造成的损失的，当事人可以请求人民法院或者仲裁机构予以适当减少。"],
  ];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ packId: "legal-cn-enterprise", contentVersion: "V27" }));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(docs));
  const db = new DatabaseSync(path.join(dir, "legal.sqlite"));
  db.exec(`CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT NOT NULL, article TEXT NOT NULL, text TEXT NOT NULL,
    source_path TEXT NOT NULL, category TEXT NOT NULL, verified TEXT NOT NULL, verified_note TEXT NOT NULL,
    authority TEXT NOT NULL, promulgated_at TEXT NOT NULL, effective_at TEXT NOT NULL)`);
  const insert = db.prepare("INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, 'FLK_A', '', '全国人大常委会', '', '')");
  rows.forEach(([source, title, article, text], i) => insert.run(`${source}#${article}@${i}`, title, article, text, source, docs.find((d) => d.sourcePath === source).category));
  db.close();

  const corpus = new LegalCorpus({
    packDir: dir,
    aliases: { LAW_ALIASES: { 民诉法: "民事诉讼法" }, INTENT_STOPWORDS: new Set(["情形"]) },
    openDatabase: (file) => new DatabaseSync(file, { readOnly: true }),
  });
  const validity = { "中华人民共和国合同法": "expired" };
  const deps = (lanes = {}) => ({
    v2Search: async (query, mode) => lanes[mode] || [],
    lawValidity: async (title) => validity[title] || "effective",
  });
  const top = (result) => result.results.map((r) => `${r.law}${r.article}`);

  // ---------------------------------------------------------------- numbers
  assert.deepEqual([1, 10, 19, 39, 110, 188, 585, 1005, 1260].map(intToChinese), ["一", "十", "十九", "三十九", "一百一十", "一百八十八", "五百八十五", "一千零五", "一千二百六十"]);
  assert.equal(articleLabel("劳动合同法第39条"), "第三十九条");
  assert.equal(articleLabel("刑法第二百八十七条之二"), "第二百八十七条之二");
  assert.equal(baseTitle("《中华人民共和国民法典·合同编》"), "民法典");
  check("article numbers and law titles are read the way the corpus spells them");

  // ------------------------------------------------- the lawyer's two steps
  {
    const named = await searchLegal(corpus, { query: "竞业限制期限不得超过几年", laws: ["劳动合同法"], topK: 3 }, deps());
    assert.equal(top(named)[0], "劳动合同法第二十四条", "a law named by the agent is searched article by article");
    assert.equal(named.laws[0].source, "caller");
    assert.match(named.results[0].text, /不得超过二年/, "and the article comes back whole, from the corpus");
    const exact = await searchLegal(corpus, { query: "劳动合同法第39条", topK: 3 }, deps());
    assert.deepEqual([top(exact)[0], exact.results[0].lane, exact.laws[0].source], ["劳动合同法第三十九条", "exact", "named"], "a law and article named in the question are looked up exactly");
    assert.doesNotMatch(exact.results[0].text, /2007/, "in the law's current version, not a superseded one");
    const code = await searchLegal(corpus, { query: "违约金过分高于造成的损失", laws: ["民法典"], topK: 3 }, deps());
    assert.equal(top(code)[0], "民法典第五百八十五条", "a code's 编 are one law");
    const abbreviated = await searchLegal(corpus, { query: "民诉法第一百一十九条", topK: 2 }, deps());
    assert.equal(top(abbreviated)[0], "民事诉讼法第一百一十九条", "a registered abbreviation names its law");
    check("the governing law is found first, then its article — exactly when numbered");
  }

  {
    // No law named: the service's lanes vote, national law above local regulation.
    // The provincial regulation leads both lanes; only the legal hierarchy puts the national law first.
    const lanes = {
      semantic: [{ title: "某省劳动合同条例", validity: "effective" }, { title: "中华人民共和国劳动合同法", validity: "effective" }],
      lexical: [{ title: "某省劳动合同条例", validity: "effective" }, { title: "中华人民共和国劳动合同法", validity: "effective" }],
    };
    const voted = await searchLegal(corpus, { query: "用人单位 解除劳动合同 严重违反规章制度", topK: 3 }, deps(lanes));
    assert.equal(voted.laws[0].name, "劳动合同法", "the national law outvotes a provincial regulation ranked above it");
    assert.equal(top(voted)[0], "劳动合同法第三十九条");
    assert.ok(corpus.articlesOf("劳动合同法").every((row) => row.article !== "题注"), "a caption is not an article");
    const repealed = await searchLegal(corpus, { query: "违约金过分高于造成的损失", topK: 3 }, deps({ lexical: [{ title: "中华人民共和国合同法", validity: "expired" }] }));
    assert.equal(repealed.results.length, 0, "a repealed law does not win the vote");
    const asked = await searchLegal(corpus, { query: "违约金过分高于造成的损失", laws: ["合同法"], topK: 3 }, deps());
    assert.equal(asked.results.length, 0, "nor answer when named — its articles are held back");
    const historical = await searchLegal(corpus, { query: "违约金过分高于造成的损失", laws: ["合同法"], topK: 3, includeHistorical: true }, deps());
    assert.deepEqual([top(historical)[0], historical.results[0].validity], ["合同法第一百一十四条", "expired"], "unless history is asked for, and then it says so");
    const wrong = await searchLegal(corpus, { query: "用人单位 解除劳动合同 严重违反规章制度", laws: ["民法典"], topK: 5 }, deps(lanes));
    assert.ok(top(wrong).includes("劳动合同法第三十九条"), "a caller naming the wrong law is still backed by the vote");
    check("without a named law the lanes vote; repealed law is held back; a wrong guess is backed up");
  }

  {
    const unknown = await searchLegal(corpus, { query: "竞业限制", laws: ["不存在的法"], topK: 3 }, deps());
    assert.deepEqual(unknown.unresolvedLaws, ["不存在的法"], "a law the corpus does not hold is reported, not invented");
    const failing = await searchLegal(corpus, { query: "竞业限制期限", laws: ["劳动合同法"], topK: 2 }, {
      v2Search: async () => { throw new Error("V2 down"); }, lawValidity: async () => { throw new Error("V2 down"); }, log: () => {},
    });
    assert.deepEqual([top(failing)[0], failing.results[0].validity], ["劳动合同法第二十四条", "unknown"], "with the V2 service down the corpus still answers, validity unknown");
    const article = getArticle(corpus, { law: "劳动合同法", article: "第41条" });
    assert.equal(article.article.article, "第四十一条", "an article is fetched by law and number");
    assert.equal(getArticle(corpus, { id: article.article.id }).article.id, article.article.id, "or by id");
    assert.equal(getArticle(corpus, { law: "劳动合同法", article: "第九百条" }).error, "LEGAL_ARTICLE_NOT_FOUND");
    check("unknown laws are reported; a failing V2 service costs validity, not answers; articles fetch whole");
  }
  {
    // The served process, on a managed runtime: an update or rollback is the
    // next request's corpus, without a restart.
    const { spawn } = await import("node:child_process");
    const runtime = path.join(dir, "runtime");
    for (const release of ["V27-base", "V27-update"]) {
      const folder = path.join(runtime, "releases", release);
      fs.mkdirSync(folder, { recursive: true });
      for (const file of ["manifest.json", "catalog.json", "legal.sqlite"]) fs.copyFileSync(path.join(dir, file), path.join(folder, file));
    }
    const updated = new DatabaseSync(path.join(runtime, "releases", "V27-update", "legal.sqlite"));
    updated.prepare("UPDATE articles SET text = ? WHERE article = '第二十四条'").run("（2026 修改）竞业限制期限，不得超过一年。");
    updated.close();
    const point = (releaseId) => fs.writeFileSync(path.join(runtime, "active.json"), JSON.stringify({ kind: "v27-active-v1", releaseId }));
    point("V27-base");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ["deploy/legal-kb/gateway/server.cjs", "--runtime", runtime, "--port", String(port), "--v2", "http://127.0.0.1:1"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    try {
      for (let i = 0; i < 100 && !output.includes("legal retrieval gateway on"); i += 1) await new Promise((r) => setTimeout(r, 50));
      const ask = async () => (await (await fetch(`http://127.0.0.1:${port}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "竞业限制期限", laws: ["劳动合同法"], topK: 1 }) })).json());
      const before = await ask();
      assert.deepEqual([before.releaseId, /二年/.test(before.results[0].text)], ["V27-base", true], `the pointer's release is served: ${output}`);
      point("V27-update");
      const after = await ask();
      assert.deepEqual([after.releaseId, /一年/.test(after.results[0].text)], ["V27-update", true], "an applied update is the next request's corpus");
      fs.writeFileSync(path.join(runtime, "active.json"), "{ half-written");
      assert.equal((await ask()).releaseId, "V27-update", "a pointer caught mid-write keeps the open release serving");
      point("../../escape");
      assert.equal((await ask()).releaseId, "V27-update", "and a pointer outside the runtime is refused");
      const outside = path.join(dir, "outside-release");
      fs.mkdirSync(outside);
      for (const file of ["manifest.json", "catalog.json", "legal.sqlite"]) fs.copyFileSync(path.join(dir, file), path.join(outside, file));
      fs.symlinkSync(outside, path.join(runtime, "releases", "linked"));
      point("linked");
      assert.equal((await ask()).releaseId, "V27-update", "as is a well-formed release that is a link out of it");
      point("V27-base");
      assert.equal((await ask()).releaseId, "V27-base", "a rollback is served the same way");
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.deepEqual([health.ok, health.releaseId, health.v2.ok], [true, "V27-base", false], "health names the release and reports V2 down, without failing");
    } finally {
      child.kill();
    }
    check("on a managed runtime the active release is served per request: update, rollback, bad pointer");
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`legal-retrieval-gateway: ok (${checks} checks)`);
