#!/usr/bin/env node
// The phone's history is the desktop's history: newest turns, the desktop's
// text rules, no internal rows. Regression guard for "同步的消息内容不对" —
// the phone showed a long session's FIRST turns (oldest-first LIMIT) and
// dropped/relabelled messages the desktop renders fine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { mobileConversationView, MAX_TEXT_CHARS } = require(path.join(ROOT, "src/main/mobile/conversation-view.js"));
const { toPhone } = require(path.join(ROOT, "src/main/mobile/protocol.js"));

const iso = (n) => new Date(Date.UTC(2026, 8, 24, 0, 0, n)).toISOString();

// --- a long session: the phone gets the NEWEST turns, oldest-first order -----
{
  const conversation = [];
  for (let i = 0; i < 94; i += 1) {
    conversation.push({ id: `u${i}`, role: "user", content: `问题 ${i}`, turnId: `t${i}`, timestamp: iso(i * 2) });
    conversation.push({ id: `a${i}`, role: "assistant", content: `回答 ${i}`, turnId: `t${i}`, timestamp: iso(i * 2 + 1) });
  }
  const { items, truncated } = mobileConversationView(conversation, { limit: 20 });
  assert.equal(items.length, 20);
  assert.equal(truncated, true);
  assert.equal(items.at(-1).text, "回答 93", "the latest reply is on the phone");
  assert.equal(items[0].text, "问题 84", "the window is the last 20 messages, not the first");
  assert.ok(items.every((item, i) => i === 0 || item.ts >= items[i - 1].ts), "oldest-first within the window");
}

// --- the desktop's text rules ------------------------------------------------
{
  const { items } = mobileConversationView([
    { id: "u1", role: "user", content: "看下这个报错", files: [{ path: "/x.png" }] },
    // A rich turn: the answer lives in record.assistantText, content is empty.
    { id: "a1", role: "assistant", content: "", record: { assistantText: "原因是端口被占用", meta: {} } },
    { id: "tool1", role: "tool", content: "npm ERR! secret stack" },
    { id: "sys1", role: "system", content: "internal notice" },
    { id: "a0", role: "assistant", content: "旧回答", meta: { superseded: true } },
    { id: "a2", role: "assistant", content: "已中断", record: { meta: { interrupted: true } } },
    { id: "a3", role: "assistant", content: "失败原因", record: { terminal: "turn.failed", meta: { failed: true } } },
    { id: "u2", role: "user", content: "   " },
  ]);
  assert.deepEqual(items.map((i) => i.id), ["u1", "a1", "a2", "a3"], "tool/system rows, superseded answers and blank rows are not conversation");
  assert.equal(items[0].files, 1, "attachments are counted, not shipped");
  assert.equal(items[1].text, "原因是端口被占用", "a rich turn's answer comes from record.assistantText");
  assert.equal(items[1].role, "assistant");
  assert.equal(items[2].status, "interrupted");
  assert.equal(items[3].status, "failed");
  assert.ok(!items.some((i) => i.role !== "user" && i.role !== "assistant"), "no row is relabelled");
}

// --- bounded for a small screen and a 256 KB relay frame ---------------------
{
  const huge = "长".repeat(MAX_TEXT_CHARS + 500);
  const { items } = mobileConversationView([{ id: "a", role: "assistant", content: huge }]);
  assert.equal(items[0].cut, true);
  assert.ok(items[0].text.length <= MAX_TEXT_CHARS + 1);

  const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, role: "assistant", content: "字".repeat(5000), timestamp: iso(i) }));
  const bounded = mobileConversationView(many, { limit: 60 });
  const frame = toPhone.sessionContext({ session: { id: "s", title: "t" }, items: bounded.items });
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 250 * 1024, "the context frame always fits the relay's 256 KB limit");
  assert.equal(bounded.items.at(-1).id, "m59", "budget trimming drops the OLDEST, never the newest");
}

assert.deepEqual(mobileConversationView(null).items, []);

// --- the turn running NOW is "running", not the "stalled" an open turn looks like
{
  const open = [
    { id: "u", role: "user", content: "继续", turnId: "t9" },
    { id: "a", role: "assistant", content: "正在分析", turnId: "t9", record: { terminal: "turn.stalled", meta: { stalled: true } } },
  ];
  assert.equal(mobileConversationView(open).items[1].status, "stalled");
  assert.equal(mobileConversationView(open, { runningTurnId: "t9" }).items[1].status, "running");
}

// --- wiring: the phone reads the desktop's conversation source, engine-free --
{
  const port = fs.readFileSync(path.join(ROOT, "src/main/mobile/desktop-port.js"), "utf8");
  assert.match(port, /getConversationPageFromSource\(ctx, sessionId, \{[\s\S]*preferLocal: true,[\s\S]*allowEngineSpawn: false/, "local-first, never boots the engine for a phone read");
  for (const file of fs.readdirSync(path.join(ROOT, "src/main/mobile"))) {
    const src = fs.readFileSync(path.join(ROOT, "src/main/mobile", file), "utf8");
    assert.ok(!/getProjectedConversation/.test(src), `${file}: the phone never reads the projection table directly`);
  }
}

// The phone shows the conversation in the DESKTOP's display order — one shared
// definition (src/shared/committed-message-order.mjs). Field case: a question
// asked while the previous turn ran is stored at admission, before that
// turn's answer; the phone showed it there, the desktop after the answer.
{
  const t = (m) => new Date(Date.UTC(2026, 8, 25, 10, 0, m)).toISOString();
  const stored = [
    { id: "u1", role: "user", content: "问题 1", turnId: "t1", timestamp: t(0) },
    { id: "u2", role: "user", content: "问题 2（上一轮还在跑时问的）", turnId: "t2", timestamp: t(1) },
    { id: "a1", role: "assistant", content: "回答 1", turnId: "t1", timestamp: t(2) },
    { id: "a2", role: "assistant", content: "回答 2", turnId: "t2", timestamp: t(3) },
  ];
  const view = mobileConversationView(stored);
  assert.deepEqual(view.items.map((i) => i.text), ["问题 1", "回答 1", "问题 2（上一轮还在跑时问的）", "回答 2"], "question before its answer, turns in order");
  const src = fs.readFileSync(path.join(ROOT, "src/main/mobile/conversation-view.js"), "utf8");
  assert.match(src, /require\("\.\.\/\.\.\/shared\/committed-message-order\.mjs"\)/, "the desktop's own ordering, not a copy");
  const renderer = fs.readFileSync(path.join(ROOT, "src/renderer/modules/message-committed-render-model.js"), "utf8");
  assert.match(renderer, /from "\.\.\/\.\.\/shared\/committed-message-order\.mjs"/, "and the desktop uses that same definition");
  // The phone page carries a copy (web/ cannot import src/): byte-identical after its header.
  const shared = fs.readFileSync(path.join(ROOT, "src/shared/committed-message-order.mjs"), "utf8");
  const copy = fs.readFileSync(path.join(ROOT, "web/lib/mobile/committed-message-order.mjs"), "utf8");
  assert.equal(copy.slice(copy.indexOf("// The order a conversation")), shared, "the phone's copy is the shared definition, verbatim");
}

console.log("mobile-conversation-view: ok");
