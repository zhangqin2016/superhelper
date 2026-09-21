#!/usr/bin/env node
// 模型自己说了下一步，回合却就此结束——平台要把它推回去做完。
//
// 现场 2026-09-21：一轮任务发现了真缺陷（持久化测试通过、订阅者却报 world state
// 保存失败被吞掉），模型写下「这才是要闭环的东西。先追根因。」然后停了。已有的三道
// 闸门全部满足：构建绿、十条待办全完成、没有声称任何交付物。模型没有放弃，是没人
// 让它继续。
//
// 这道闸门读的是模型自己的收尾句，因此最大的风险是反向误判：把面向用户的提问或提议
// 当成宣告，等于抢话并白费一轮模型调用。判定规则是在 399 条真实助手回合上定的——
// 其中 24.6% 以面向用户收尾，只有 0.5% 是真正的自我宣告。[gate: announced-continuation]
// Run: node scripts/test-announced-continuation.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const policy = require("../src/main/announced-continuation-policy.js");
const { DEFAULT_MAX_TURN_CONTINUATIONS, claimContinuation, createTurnGateState } = require("../src/main/turn-continuation-budget.js");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

check("现场那句话会触发，而且引用的是模型自己的原话", () => {
  const hit = policy.detectAnnouncedContinuation("构建全绿（EXIT=0）。但日志里发现一个真实缺陷。这才是要闭环的东西。先追根因。");
  assert.ok(hit, "宣告了下一步就必须被接住");
  assert.equal(hit.fragment, "先追根因。");
  const prompt = policy.buildAnnouncedContinuationPrompt(hit.fragment);
  assert.ok(prompt.includes("先追根因。"), "推回去时引用原话，不另行编造任务");
  assert.match(prompt, /如果这件事其实不需要做/, "留出「本来就不用做」的出口，误判只花一轮");
});

check("面向用户的收尾永不触发——这是 24.6% 的多数情况", () => {
  for (const text of [
    "要不要我下一步专门处理，或者你知道这事？",
    "可以直接继续提问，我会接着把剩下的部分做完。",
    "需要我继续做什么吗？",
    "要我继续做这个「提交按钮」吗？还是先就到这里、你自己 review？",
    "Let me know if you need anything else.",
  ]) {
    assert.equal(policy.detectAnnouncedContinuation(text), null, `面向用户：${text.slice(0, 24)}`);
  }
});

check("否定、已完成、结构行都不是宣告", () => {
  assert.equal(policy.detectAnnouncedContinuation("所有后端行为我验证不了其内容本身。"), null, "「验证不了」是相反的意思");
  assert.equal(policy.detectAnnouncedContinuation("这次就是我漏了这一步，已经在 5173 上补上了。"), null, "已经做完的事不是待办");
  assert.equal(policy.detectAnnouncedContinuation("我做了操作、系统装作没看见。"), null, "过去时不是宣告");
  assert.equal(policy.detectAnnouncedContinuation("后端 devtools 自动完成建表迁移 + 重启，我验证端点上线 3."), null, "被切碎的列表项不是收尾句");
  assert.equal(policy.detectAnnouncedContinuation("**未能核查的部分**：API 契约全部依赖那份不在仓库的交接文档。"), null, "带强调标记的是计划汇报");
});

check("代码块里的话不算收尾句", () => {
  assert.equal(policy.detectAnnouncedContinuation("修好了。\n```js\n// 先追根因\n```\n没有其他问题。"), null);
});

check("中英文的自我宣告都认，长句不认", () => {
  assert.ok(policy.detectAnnouncedContinuation("接下来我去修这个订阅者。"));
  assert.ok(policy.detectAnnouncedContinuation("I will trace the root cause."));
  assert.ok(policy.detectAnnouncedContinuation("Let me check the failing subscriber."));
  const long = `我继续${"把这件事仔细地一步一步做完".repeat(6)}。`;
  assert.equal(policy.detectAnnouncedContinuation(long), null, "收尾宣告是短句；长段落是叙述");
});

check("闸门的前置条件：只在干净结束、做过事、且本轮没用过时才进", () => {
  const base = () => ({
    _server: {}, _pendingPermissions: new Set(), _pendingQuestions: new Set(),
    _turnGates: createTurnGateState(), _toolCalls: new Set(["bash"]),
    sessionId: "s1", collectedOutput: "", _armResponseTimer() {}, _armProgressNoticeTimer() {},
  });
  const deps = () => { const sent = []; return { sent, claimContinuation, nudgePlatformPrompt: (_s, input) => sent.push(input), kind: "self_check", log: { warn() {} } }; };
  const payload = { code: 0, output: "先追根因。" };

  const d1 = deps();
  assert.equal(policy.continueAnnouncedWork(base(), payload, d1), true, "干净结束 + 做过事 + 有宣告 → 推回去");
  assert.equal(d1.sent.length, 1);
  assert.equal(d1.sent[0].reason, "announced continuation");

  for (const [name, mutate, load] of [
    ["被打断", (s) => s, { code: 0, interrupted: true, output: "先追根因。" }],
    ["非零退出", (s) => s, { code: 1, output: "先追根因。" }],
    ["引擎已停", (s) => { s._server = null; return s; }, payload],
    ["等待用户许可", (s) => { s._pendingPermissions.add("x"); return s; }, payload],
    ["本轮已用过", (s) => { s._turnGates.announcedGated = true; return s; }, payload],
    ["没做过事", (s) => { s._toolCalls = new Set(); return s; }, payload],
  ]) {
    const d = deps();
    assert.equal(policy.continueAnnouncedWork(mutate(base()), load, d), false, name);
    assert.equal(d.sent.length, 0, `${name}：不得发出追问`);
  }
});

check("每回合至多一次，并且共享全局重入预算", () => {
  const session = {
    _server: {}, _pendingPermissions: new Set(), _pendingQuestions: new Set(),
    _turnGates: createTurnGateState(), _toolCalls: new Set(["bash"]),
    sessionId: "s2", collectedOutput: "", _armResponseTimer() {}, _armProgressNoticeTimer() {},
  };
  const sent = [];
  const deps = { claimContinuation, nudgePlatformPrompt: (_s, i) => sent.push(i), kind: "self_check", log: { warn() {} } };
  const payload = { code: 0, output: "先追根因。" };
  assert.equal(policy.continueAnnouncedWork(session, payload, deps), true);
  session._turnGates.announcedGated = false; // 即使旁路了自己的标记
  session._turnGates.continuations = DEFAULT_MAX_TURN_CONTINUATIONS; // 预算已被其它闸门花光
  assert.equal(policy.continueAnnouncedWork(session, payload, deps), false, "预算耗尽必须优雅收尾，而不是再花一轮");
  assert.equal(sent.length, 1);
});

check("关闭开关后完全不生效", () => {
  const before = process.env.LILY_ANNOUNCED_CONTINUATION_GATE;
  process.env.LILY_ANNOUNCED_CONTINUATION_GATE = "0";
  try {
    const session = {
      _server: {}, _pendingPermissions: new Set(), _pendingQuestions: new Set(),
      _turnGates: createTurnGateState(), _toolCalls: new Set(["bash"]),
      sessionId: "s3", collectedOutput: "", _armResponseTimer() {}, _armProgressNoticeTimer() {},
    };
    const sent = [];
    assert.equal(policy.continueAnnouncedWork(session, { code: 0, output: "先追根因。" },
      { claimContinuation, nudgePlatformPrompt: (_s, i) => sent.push(i), log: { warn() {} } }), false);
    assert.equal(sent.length, 0);
  } finally {
    if (before === undefined) delete process.env.LILY_ANNOUNCED_CONTINUATION_GATE;
    else process.env.LILY_ANNOUNCED_CONTINUATION_GATE = before;
  }
});

console.log(`\n${checks} checks passed (announced continuation)`);
