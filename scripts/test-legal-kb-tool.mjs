import assert from "node:assert/strict";
import { allToolDefinitions } from "../src/main/mcp/tool-broker-registry.js";
import { resolveToolSemantics } from "../src/main/tool-semantics.js";

let called = null;
const tools = allToolDefinitions({ platformOnly: true }, {
  legalKnowledgeManager: {
    async search(args) { called = args; return { ok: true, results: [{ title: "合同法", article: "第一条" }] }; },
  },
});
const tool = tools.find((item) => item.name === "lily_legal_search");
assert.ok(tool, "legal search tool is registered");
assert.equal(tool.annotations.readOnlyHint, true);
assert.equal(resolveToolSemantics(tool).evidenceKind, "knowledge_base");
assert.equal(tool.requiredSkillIds.length, 0);
const result = await tool.handler({ query: "合同成立", topK: 5 }, { platformOnly: true }, {
  legalKnowledgeManager: { async search(args) { called = args; return { ok: true, results: [{ title: "合同法", article: "第一条" }] }; } },
});
assert.equal(result.ok, true);
assert.deepEqual(called, { query: "合同成立", topK: 5 });

console.log("legal kb tool tests passed");
