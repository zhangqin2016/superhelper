import assert from "node:assert/strict";
import { allToolDefinitions } from "../src/main/mcp/tool-broker-registry.js";
import { resolveToolSemantics } from "../src/main/tool-semantics.js";

let called = null;
const stub = {
  async searchLegalKnowledgeRemote(args) {
    called = args;
    return { ok: true, results: [{ title: "合同法", article: "第一条" }] };
  },
};
const tools = allToolDefinitions({ platformOnly: true }, { legalKnowledgeRemote: stub });
const tool = tools.find((item) => item.name === "lily_legal_search");
assert.ok(tool, "legal search tool is registered");
assert.equal(tool.annotations.readOnlyHint, true);
assert.equal(resolveToolSemantics(tool).evidenceKind, "knowledge_base");
assert.equal(tool.requiredSkillIds.length, 0);
assert.doesNotMatch(tool.description, /local .*pack/i, "the tool no longer advertises a local pack");
assert.match(tool.description, /served|server/i, "and points at the served corpus");
assert.match(tool.description, /governing law/i, "it tells the model to name the governing law");
assert.ok(tool.inputSchema.laws, "and takes it as `laws`");
assert.ok(!tool.inputSchema.mode, "the retrieval lane is the server's decision, not the model's");
const result = await tool.handler({ query: "合同成立", laws: ["民法典"], topK: 5 }, { platformOnly: true }, { legalKnowledgeRemote: stub });
assert.equal(result.ok, true);
assert.deepEqual([called.query, called.laws, called.topK], ["合同成立", ["民法典"], 5]);

const article = tools.find((item) => item.name === "lily_legal_article");
assert.ok(article, "a full-text article tool is registered");
assert.equal(resolveToolSemantics(article).evidenceKind, "knowledge_base", "and is evidence like the search");
let fetched = null;
await article.handler({ law: "劳动合同法", article: "第39条" }, { platformOnly: true }, {
  legalKnowledgeRemote: { async getLegalArticleRemote(args) { fetched = args; return { ok: true }; } },
});
assert.deepEqual([fetched.law, fetched.article], ["劳动合同法", "第39条"]);

console.log("legal kb tool tests passed");
