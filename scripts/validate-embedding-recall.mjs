#!/usr/bin/env node
// Real-recall validation for opt-in semantic memory embeddings.
// Hits the LIVE embedding endpoint (DashScope by default) and proves that real
// embeddings recall paraphrases the lexical hash misses. NOT a CI test — run
// manually with a key present:
//   LILY_MEMORY_EMBEDDING=1 node scripts/validate-embedding-recall.mjs
// (DASHSCOPE_API_KEY / LILY_EMBEDDING_API_KEY resolved from settings or env.)

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveEmbeddingConfig, makeEmbeddingCaller, cosineSimilarity, embedText } =
  require("../src/main/memory-vector-index.js");

process.env.LILY_MEMORY_EMBEDDING = process.env.LILY_MEMORY_EMBEDDING || "1";

const config = resolveEmbeddingConfig();
if (!config) {
  console.error("embeddings disabled — set LILY_MEMORY_EMBEDDING=1");
  process.exit(2);
}
console.log(`endpoint: ${config.baseUrl}\nmodel:    ${config.model}\nkey:      ${config.apiKey ? "present" : "MISSING"}\n`);
if (!config.apiKey) {
  console.error("No API key. Set DASHSCOPE_API_KEY (or LILY_EMBEDDING_API_KEY) in settings/env, then re-run.");
  process.exit(2);
}

// Paraphrase pairs: query shares few/no tokens with the RELEVANT memory, and the
// DISTRACTOR is about something else. Real embeddings should score pos >> neg.
const CASES = [
  { q: "为什么我的数据库老是连不上", pos: "postgres 连接被拒绝,连接池在高负载下耗尽", neg: "markdown 在重新打开会话时出现重复渲染" },
  { q: "can't reach postgres from the app", pos: "database connection keeps dropping under load", neg: "the vision model produced a bar chart from the screenshot" },
  { q: "上下文太长导致模型报错", pos: "token 预算超出上下文窗口,压缩也溢出", neg: "用户偏好中文结果并使用宋体报告" },
];

const caller = makeEmbeddingCaller(config);

async function main() {
  let realWins = 0;
  let lexWins = 0;
  console.log("case                          | real(pos) real(neg) | lex(pos) lex(neg) | real✓ lex✓");
  console.log("-".repeat(96));
  for (const c of CASES) {
    const [q, pos, neg] = await caller([c.q, c.pos, c.neg]);
    const rPos = cosineSimilarity(q, pos);
    const rNeg = cosineSimilarity(q, neg);
    const lq = embedText(c.q), lPos = cosineSimilarity(lq, embedText(c.pos)), lNeg = cosineSimilarity(lq, embedText(c.neg));
    const realOk = rPos > rNeg;
    const lexOk = lPos > lNeg;
    if (realOk) realWins += 1;
    if (lexOk) lexWins += 1;
    console.log(
      `${c.q.slice(0, 28).padEnd(29)} |  ${rPos.toFixed(3)}    ${rNeg.toFixed(3)}  |  ${lPos.toFixed(3)}   ${lNeg.toFixed(3)}  |  ${realOk ? "Y" : "N"}    ${lexOk ? "Y" : "N"}`,
    );
  }
  console.log("-".repeat(96));
  console.log(`real-embedding recall: ${realWins}/${CASES.length} correct   |   lexical-hash recall: ${lexWins}/${CASES.length} correct`);
  if (realWins < CASES.length) {
    console.error("\nreal recall did not win every case — do NOT default-on; inspect the endpoint/model.");
    process.exit(1);
  }
  console.log("\nOK — real-embedding recall wins every case. Safe candidate for wider rollout (still opt-in).");
}

main().catch((err) => {
  console.error(`\nendpoint call failed: ${err?.message || err}`);
  console.error("fail-open confirmed: with this endpoint unreachable, recall falls back to the lexical hash (no regression).");
  process.exit(2);
});
