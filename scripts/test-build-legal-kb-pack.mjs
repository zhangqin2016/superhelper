import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { buildLegalKnowledgePack } from "./build-legal-kb-pack.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-legal-kb-builder-"));
const outputDir = path.join(root, "pack");
const zip = new JSZip();
zip.file("legal_kb_package\\laws_manifest.json", JSON.stringify({
  version: "V23.3",
  content_version: "V23.3",
  generated: "2026-08-17T00:00:00.000Z",
  total: 1,
  total_articles: 2,
  items: [{
    title: "中华人民共和国合同法示例",
    file: "法规库/民商法/合同法.md",
    category: "法律",
    verified: "FLK_A",
    zdjg: "全国人民代表大会常务委员会",
  }],
}));
zip.file("legal_kb_package\\output\\version_lineage.json", JSON.stringify({ generated: "2026-08-17", chains: 0, lineage: [] }));
zip.file("legal_kb_package\\法规库\\民商法\\合同法.md", [
  "# 中华人民共和国合同法示例",
  "",
  "## 第一条",
  "为了保护合同当事人的合法权益，制定本法。",
  "",
  "## 第二条",
  "本法适用于平等主体之间的合同关系。",
  "> 第三条",
  "当事人应当遵循诚信原则。",
  "",
  "**第一条**",
  "同一文件内的其他司法解释也可以从第一条开始。",
].join("\n"));
zip.file("legal_kb_package\\法规库\\_归档_已废止.md", "## 第一条\n不应进入现行检索。\n");
zip.file("legal_kb_package\\tools\\law_query.cjs", "process.exit(1)");
zip.file("legal_kb_package\\output\\vector_search.js", "window.VECTOR_SEARCH = {};");

const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const result = await buildLegalKnowledgePack({ archiveBuffer: archive, outputDir });
assert.equal(result.ok, true);
assert.equal(result.manifest.contentVersion, "V23.3");
assert.equal(result.manifest.articleCount, 4);
assert.equal(fs.existsSync(path.join(outputDir, "manifest.json")), true);
assert.equal(fs.existsSync(path.join(outputDir, "catalog.json")), true);
assert.equal(fs.existsSync(path.join(outputDir, "articles.jsonl")), true);
assert.equal(fs.existsSync(path.join(outputDir, "lineage.json")), true);

const articles = fs.readFileSync(path.join(outputDir, "articles.jsonl"), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
assert.deepEqual(articles.map((item) => item.article), ["第一条", "第二条", "第三条", "第一条"]);
assert.equal(new Set(articles.map((item) => item.id)).size, 4);
assert.equal(articles[0].verified, "FLK_A");
assert.match(articles[1].text, /平等主体/);
assert.equal(fs.existsSync(path.join(outputDir, "tools")), false);

console.log("legal kb builder tests passed");
