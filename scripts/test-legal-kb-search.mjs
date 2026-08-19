import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchLegalKnowledge, closeLegalKnowledgeSearch } from "../src/main/legal-kb/legal-kb-search.js";

const packPath = fs.mkdtempSync(path.join(os.tmpdir(), "lily-legal-kb-search-"));
fs.writeFileSync(path.join(packPath, "manifest.json"), JSON.stringify({
  schemaVersion: 1, packId: "legal-cn-enterprise", contentVersion: "V23.3", articleCount: 2, documentCount: 1,
}));
fs.writeFileSync(path.join(packPath, "articles.jsonl"), [
  { id: "contract#1", title: "中华人民共和国合同法示例", article: "第一条", text: "合同依法订立，双方应当遵守。", sourcePath: "法规库/合同法.md", category: "法律", verified: "FLK_A", verifiedNote: "", authority: "人大常委会", promulgatedAt: "", effectiveAt: "" },
  { id: "labor#1", title: "劳动合同法示例", article: "第三十七条", text: "劳动者提前三十日以书面形式通知用人单位，可以解除劳动合同。", sourcePath: "法规库/劳动法.md", category: "法律", verified: "VERIFIED_SOURCE", verifiedNote: "", authority: "国务院", promulgatedAt: "", effectiveAt: "" },
].map((item) => JSON.stringify(item)).join("\n") + "\n");

const result = await searchLegalKnowledge({ packPath, query: "解除劳动合同", topK: 3 });
assert.equal(result.ok, true);
assert.equal(result.packVersion, "V23.3");
assert.equal(result.results.length, 1);
assert.equal(result.results[0].article, "第三十七条");
assert.equal(result.results[0].verified, "VERIFIED_SOURCE");
assert.ok(result.results[0].excerpt.includes("解除劳动合同"));
assert.equal((await searchLegalKnowledge({ packPath, query: "x", topK: 50 })).results.length <= 20, true);
assert.equal((await searchLegalKnowledge({ packPath, query: "" })).error, "LEGAL_KB_QUERY_REQUIRED");
closeLegalKnowledgeSearch(packPath);

console.log("legal kb search tests passed");
