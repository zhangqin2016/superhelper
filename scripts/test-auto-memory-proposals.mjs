#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-auto-memory-"));
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => tempRoot, getName: () => "lily-test" } },
};

const {
  approveMemoryProposal,
  dismissMemoryProposal,
  extractMemoryProposalFromRecord,
  listMemoryProposals,
  promoteMemoryProposalsFromRecord,
  proposalKey,
} = require("../src/main/auto-memory-proposals.js");
const { readLearnedConventions } = require("../src/main/learned-context.js");

try {
  assert.equal(
    proposalKey("回答统一用中文。"),
    proposalKey("回答统一用中文"),
    "proposal keys normalize punctuation",
  );

  const explicit = extractMemoryProposalFromRecord({
    user: { text: "记住：回答金融报告时先给结论，再给依据" },
    assistantText: "好的",
    terminal: "turn.completed",
  });
  assert.equal(explicit?.text, "回答金融报告时先给结论，再给依据");
  assert.equal(explicit?.source, "explicit_remember");

  const correction = extractMemoryProposalFromRecord({
    user: { text: "不是这个意思，以后分析运行时问题先看 OpenCode 原生能力，不要自己造" },
    assistantText: "明白",
    terminal: "turn.completed",
  });
  assert.match(correction?.text || "", /以后分析运行时问题先看 OpenCode 原生能力/);
  assert.equal(correction?.source, "user_correction");

  assert.equal(extractMemoryProposalFromRecord({ user: { text: "你好" }, terminal: "turn.completed" }), null);
  assert.equal(extractMemoryProposalFromRecord({ user: { text: "记住：短" }, terminal: "turn.completed" }), null);

  // --- ② autonomous solution learning (opt-in, human-approved) ---
  const solvedRecord = {
    terminal: "turn.completed",
    user: { text: "帮我修好本地起不来的开发服务器，端口一直被占用报错" },
    tools: [
      { name: "Bash", status: "failed" },
      { name: "Bash", status: "done" },
      { name: "Edit", status: "done", result: { is_error: false } },
    ],
    assistantText: "已解决",
  };
  // OFF by default → no autonomous proposal (zero behavior change / no approval spam)
  delete process.env.LILY_MEMORY_LEARN_SOLUTIONS;
  assert.equal(extractMemoryProposalFromRecord(solvedRecord), null, "solution learning off by default");

  // ON → distills a reusable path proposal, high-precision
  process.env.LILY_MEMORY_LEARN_SOLUTIONS = "1";
  const solved = extractMemoryProposalFromRecord(solvedRecord);
  assert.equal(solved?.source, "distilled_solution");
  assert.match(solved.text, /端口一直被占用/, "lesson names the problem");
  assert.match(solved.text, /Bash|Edit/, "lesson names the tools that worked");
  assert.match(solved.text, /克服了 1 处报错/, "counts the overcome errors (deduped by errored tools)");

  // ON but trivial (no errored tool) → null (skips one-shot wins → no noise)
  assert.equal(
    extractMemoryProposalFromRecord({ terminal: "turn.completed", user: { text: solvedRecord.user.text }, tools: [{ name: "Read", status: "done" }] }),
    null,
    "no struggle → no solution lesson",
  );
  // ON but non-substantive problem → null
  assert.equal(
    extractMemoryProposalFromRecord({ terminal: "turn.completed", user: { text: "跑一下" }, tools: [{ name: "Bash", status: "error" }] }),
    null,
    "trivial problem → no lesson",
  );
  // explicit remember still wins over an otherwise-qualifying solution turn
  const bothSignals = extractMemoryProposalFromRecord({ ...solvedRecord, user: { text: "记住：本机开发服务器端口冲突时先 kill 占用进程" } });
  assert.equal(bothSignals?.source, "explicit_remember", "explicit intent wins over autonomous distillation");
  delete process.env.LILY_MEMORY_LEARN_SOLUTIONS;

  const first = promoteMemoryProposalsFromRecord("p1", {
    turnId: "t1",
    user: { text: "记住：回答金融报告时先给结论，再给依据" },
    assistantText: "ok",
    terminal: "turn.completed",
  });
  const duplicate = promoteMemoryProposalsFromRecord("p1", {
    turnId: "t2",
    user: { text: "记住：回答金融报告时先给结论，再给依据。" },
    assistantText: "ok",
    terminal: "turn.completed",
  });
  assert.equal(first?.status, "proposed");
  assert.equal(duplicate?.status, "duplicate");

  const proposals = listMemoryProposals("p1");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].text, "回答金融报告时先给结论，再给依据");
  assert.equal(proposals[0].status, "proposed");
  assert.equal(proposals[0].turnId, "t1");
  assert.equal(listMemoryProposals("other").length, 0);

  const approved = approveMemoryProposal("p1", proposals[0].key, { approvedBy: "test" });
  assert.equal(approved?.status, "approved");
  assert.match(readLearnedConventions("p1"), /回答金融报告时先给结论，再给依据/);
  assert.equal(listMemoryProposals("p1")[0].status, "approved");

  promoteMemoryProposalsFromRecord("p1", {
    turnId: "t3",
    user: { text: "记住：以后代码修改必须先跑相关测试" },
    assistantText: "ok",
    terminal: "turn.completed",
  });
  const second = listMemoryProposals("p1").find((item) => item.text.includes("先跑相关测试"));
  assert(second, "second proposal should exist before dismiss");
  const dismissed = dismissMemoryProposal("p1", second.key, { dismissedBy: "test" });
  assert.equal(dismissed?.status, "dismissed");
  assert.equal(listMemoryProposals("p1").some((item) => item.key === second.key), false);
  assert.equal(listMemoryProposals("p1", { includeDismissed: true }).some((item) => item.key === second.key), true);

  console.log("auto-memory-proposals: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
