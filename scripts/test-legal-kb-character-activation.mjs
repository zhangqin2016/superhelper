import assert from "node:assert/strict";
import { ensureLegalKnowledgeForRevision, requiresLegalKnowledge } from "../src/main/legal-kb/legal-kb-character.js";

const legalRevision = { source: { kind: "official", officialId: "lily-cn-legal-counsel" } };
const customRevision = { source: { kind: "user", officialId: "lily-cn-legal-counsel" } };
assert.equal(requiresLegalKnowledge(legalRevision), true);
assert.equal(requiresLegalKnowledge(customRevision), false);
assert.equal(requiresLegalKnowledge(null), false);

let calls = 0;
const ready = await ensureLegalKnowledgeForRevision(legalRevision, {
  manager: { async ensure(options) { calls += 1; options.onProgress({ phase: "downloading", writtenBytes: 5, totalBytes: 10 }); return { ok: true, version: "V23.3", path: "/local/legal-kb" }; } },
  onProgress: () => {},
});
assert.equal(ready.required, true);
assert.equal(ready.ready, true);
assert.equal(calls, 1);

const skipped = await ensureLegalKnowledgeForRevision(customRevision, {
  manager: { async ensure() { throw new Error("must not download"); } },
});
assert.deepEqual(skipped, { required: false, ready: true });

console.log("legal kb character activation tests passed");
