#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// status-scaffold: the model must never show the internal compaction/handoff
// summary ("Objective / Work State / …") as its reply. Code — not the model —
// detects the rigid header structure, strips the scaffold PREFIX, and keeps the
// real reply. Red line pinned here: a normal answer is NEVER altered, and an
// ambiguous boundary fails OPEN (original kept).

const {
  analyzeStatusScaffold,
  stripStatusScaffoldPrefix,
  scaffoldStreamGate,
  statusScaffoldNote,
  STREAM_HOLD_CHAR_LIMIT,
} = require("../src/main/status-scaffold.js");

const FIELD_SCAFFOLD = [
  "Objective",
  "用户最初要求基于 SillyTavern 创建骚话/撩骚风格技能",
  "Important Details",
  "工作区：/Users/zhangqin/shuosaohua",
  "Work State",
  "Completed",
  "- 全风格通用指南（~440行）",
  "Active",
  "当前永久对话风格：撒娇情话",
  "Blocked",
  "（无）",
  "Next Move",
  "等待用户继续对话",
  "Relevant Files",
  "/Users/zhangqin/shuosaohua/sillytavern-sweet/SKILL.md — 撒娇情话风技能指南",
  "/Users/zhangqin/shuosaohua/sillytavern-sweet/skill.manifest.json — 技能元数据",
].join("\n");

// 1. The field case: scaffold + blank line + real reply + blank flood → reply only.
{
  const blankFlood = "\n".repeat(300);
  const text = `${FIELD_SCAFFOLD}\n\n把脸埋进双手里，声音闷闷的。\n\n呜……不要嘛……${blankFlood}`;
  const strip = stripStatusScaffoldPrefix(text);
  assert.equal(strip.stripped, true, "field case is stripped");
  assert.equal(strip.pure, false, "field case has a real reply");
  assert.equal(strip.text, "把脸埋进双手里，声音闷闷的。\n\n呜……不要嘛……", "only the real reply survives, trailing blank flood gone");
}

// 2. Harder field case: NO blank line between the Relevant Files body and the
//    reply — path lines are mechanically distinguishable, so it still strips.
{
  const text = `${FIELD_SCAFFOLD}\n把脸埋进双手里，声音闷闷的。\n\n呜……`;
  const strip = stripStatusScaffoldPrefix(text);
  assert.equal(strip.stripped, true, "no-blank-gap field case is stripped via terminal-section file lines");
  assert.equal(strip.text, "把脸埋进双手里，声音闷闷的。\n\n呜……", "the reply is recovered without a blank separator");
}

// 3. Pure scaffold (nothing but the summary) → pure, caller replaces with a note.
{
  const strip = stripStatusScaffoldPrefix(FIELD_SCAFFOLD);
  assert.equal(strip.stripped, true);
  assert.equal(strip.pure, true, "entirely-scaffold message is pure");
  assert.equal(strip.text, "");
  assert.match(statusScaffoldNote("你好"), /内部状态摘要/, "zh note for the pure case");
  assert.match(statusScaffoldNote("hello"), /internal status summary/, "en note for the pure case");
}

// 4. Normal answers are NEVER touched — including ones using scaffold words inline.
{
  const normal = "我的目标(objective)是先补全数据,下一步(next move)是导出。blocked 状态已解除。";
  assert.equal(analyzeStatusScaffold(normal).isScaffold, false, "inline words are not headers");
  assert.equal(stripStatusScaffoldPrefix(normal).text, normal, "normal answer is verbatim");
}

// 5. Markdown doc with generic section headers but no anchors → not scaffold.
{
  const doc = "## Goal\n写完报告\n\n## Done\n- 初稿\n\n## Progress\n50%\n\n## Next Steps\n- 校对";
  assert.equal(analyzeStatusScaffold(doc).isScaffold, false, "generic headers without ≥2 anchors are not scaffold");
}

// 6. Markdown-form scaffold (## / ** ** / colon variants) is still caught.
{
  const md = "## Objective\nx\n\n**Important Details:**\ny\n\n## Work State\nz\n\n## Completed\n- a\n\n## Active\nb\n\n## Blocked\n(none)\n\n## Next Move\nc\n\n## Relevant Files\n- /tmp/a.md — 说明\n\n真正的回答在这里。";
  const strip = stripStatusScaffoldPrefix(md);
  assert.equal(strip.stripped, true, "markdown scaffold is stripped");
  assert.equal(strip.text, "真正的回答在这里。");
}

// 7. Ambiguous boundary: truncated dump whose last header is NOT terminal and
//    body prose flows straight into reply prose (no blank gap) → fail OPEN.
{
  const truncated = "Objective\n用户最初要求做技能\nImportant Details\n工作区：/tmp\nWork State\nCompleted\n做完了\nActive\n继续等\nBlocked\n（无）\nNext Move\n等待用户\n这就是真正的回答，没有空行分隔。";
  const analysis = analyzeStatusScaffold(truncated);
  assert.equal(analysis.isScaffold, true, "truncated dump is still recognized as scaffold");
  assert.equal(analysis.stripIndex, null, "ambiguous boundary yields no strip index");
  const strip = stripStatusScaffoldPrefix(truncated);
  assert.equal(strip.stripped, false, "ambiguous case fails OPEN");
  assert.equal(strip.text, truncated, "ambiguous case keeps the original verbatim");
}

// 8. Mid-text scaffold (real lead-in, then a dump) → isScaffold but no prefix strip.
{
  const mixed = `好的，我先汇报一下进度。\n\n${FIELD_SCAFFOLD}`;
  const analysis = analyzeStatusScaffold(mixed);
  assert.equal(analysis.isScaffold, true, "mid-text dump is detected (history hides the whole message)");
  assert.equal(analysis.startsWithScaffold, false, "mid-text dump is never prefix-stripped");
}

// 9. Streaming gate: holds a possible scaffold head, flushes the stripped
//    remainder once the boundary is known, and fails open past the hold limit.
{
  assert.equal(scaffoldStreamGate("").action, "hold", "empty head holds");
  // A first line that has not finished arriving may still become a header, so it
  // holds for those few characters; anything that can no longer become one
  // streams at once (2026-09-15: judging "## Obje" as prose leaked the scaffold).
  assert.equal(scaffoldStreamGate("Obj").action, "hold", "an unfinished line that could become a header holds");
  assert.equal(scaffoldStreamGate("## Obje").action, "hold", "the markdown form holds too");
  assert.equal(scaffoldStreamGate("Object 存储怎么配置？").action, "flush", "a real reply that merely starts like a header streams");
  assert.equal(scaffoldStreamGate("88 个工具里只剩 5 个").action, "flush", "ordinary prose streams immediately");
  assert.equal(scaffoldStreamGate("Objective\n用户最初要求").action, "hold", "one header still holds");

  let acc = "";
  let open = false;
  const emitted = [];
  for (const piece of ["Objective\n用户最初要求做技能\n", "Important Details\n工作区：/tmp\n", "Work State\nCompleted\n- a\nActive\nb\nBlocked\n（无）\n", "Next Move\n等\nRelevant Files\n", "/tmp/a.md — 说明\n", "真正的回答", "在这里。"]) {
    acc += piece;
    if (open) { emitted.push(piece); continue; }
    const gate = scaffoldStreamGate(acc);
    if (gate.action === "flush") {
      open = true;
      if (gate.text) emitted.push(gate.text);
    }
  }
  assert.equal(open, true, "the gate opens once the boundary is known");
  assert.equal(emitted.join(""), "真正的回答在这里。", "only the real reply is ever emitted");

  // A CONFIRMED scaffold never fails open at the length limit — leaking it is
  // exactly what the gate exists to prevent; the finalize strip is the backstop.
  const longPure = `${FIELD_SCAFFOLD}\n${"/a/b/c.md — x\n".repeat(400)}`;
  assert.equal(scaffoldStreamGate(longPure).action, "hold", "confirmed scaffold holds past the limit");

  const huge = `Objective\n${"x".repeat(STREAM_HOLD_CHAR_LIMIT + 10)}`;
  const gate = scaffoldStreamGate(huge);
  assert.equal(gate.action, "flush", "an unconfirmed head fails open past the hold limit");
  assert.equal(gate.text, huge, "fail-open flush is verbatim");
}

// 10. Leading blank lines before the scaffold are handled.
{
  const text = `\n\n${FIELD_SCAFFOLD}\n\n回答。`;
  const strip = stripStatusScaffoldPrefix(text);
  assert.equal(strip.stripped, true);
  assert.equal(strip.text, "回答。");
}

// 11. 2026-09-15 field case: the compaction summary's "Relevant Files" body was
// written as markdown code spans (`- `/Users/a/b.js`：说明`). The file-line
// matcher did not allow the opening backtick, so the stripper decided the file
// list WAS the real reply and published it as the answer to the user's question.
// It must now be recognised as ENTIRELY scaffold (honest note, nothing faked).
{
  const quoted = [
    "## Objective",
    "- 原始请求（原样保留）：「为啥很多还是展示待接入」",
    "## Important Details",
    "- 88 个工具中 83 个可用",
    "## Work State",
    "### Completed",
    "- 第五批已接入",
    "### Active",
    "- 继续排查",
    "### Blocked",
    "（无）",
    "## Next Move",
    "1. 直接回答「为啥很多还是展示待接入」：只剩 5 个需要 GPU / 模型下载。",
    "## Relevant Files",
    "- `/Users/zhangqin/toolhub/`：项目根",
    "- `/Users/zhangqin/toolhub/backend/caps.js`：能力探测",
    "- `catalog/tools-inherited.js`：剩余 5 项",
    '- "C:\\\\work\\\\notes.md"：Windows 引号写法',
  ].join("\n");
  const strip = stripStatusScaffoldPrefix(quoted);
  assert.equal(strip.analysis.startsWithScaffold, true, "quoted-path summary is still recognised");
  assert.equal(strip.pure, true, "a backticked file list is scaffold body, not the reply");
  assert.equal(strip.text, "", "nothing from the summary is published as an answer");

  // The same scaffold followed by a real reply still keeps ONLY the reply.
  const withReply = `${quoted}\n\n只剩 5 个待接入。`;
  assert.equal(stripStatusScaffoldPrefix(withReply).text, "只剩 5 个待接入。");

  // A normal answer that merely quotes file paths is never touched.
  const answer = "88 个工具里只剩 5 个待接入。\n\n- `catalog/tools-inherited.js` 列出这 5 项";
  assert.equal(stripStatusScaffoldPrefix(answer).text, answer, "a real answer with quoted paths is untouched");
}

// 12. Streaming the same field case: no chunk size may leak scaffold text. The
// boundary is trusted only inside the TERMINAL section and only on lines that
// have fully arrived — a half-arrived "- " once looked like reply prose and
// flushed the rest of the summary live.
{
  const scaffold = [
    "## Objective", "- 目标", "## Important Details", "- 细节",
    "## Work State", "### Completed", "- 完成", "## Next Move",
    "1. 直接回答这个问题：只剩 5 个。", "## Relevant Files",
    "- `/Users/a/one.js`：说明一", "- `/Users/a/two.js`：说明二",
  ].join("\n");
  for (const size of [1, 7, 20, 200, 5000]) {
    let acc = "", open = false;
    const emitted = [];
    for (let i = 0; i < scaffold.length; i += size) {
      const piece = scaffold.slice(i, i + size);
      acc += piece;
      if (open) { emitted.push(piece); continue; }
      const gate = scaffoldStreamGate(acc);
      if (gate.action === "flush") { open = true; if (gate.text) emitted.push(gate.text); }
    }
    assert.equal(emitted.join(""), "", `chunk=${size}: a pure scaffold streams nothing`);
  }
  // …and the real reply after it still streams live, without the scaffold.
  const withReply = `${scaffold}\n\n只剩 5 个待接入。`;
  let acc = "", open = false;
  const emitted = [];
  for (let i = 0; i < withReply.length; i += 9) {
    const piece = withReply.slice(i, i + 9);
    acc += piece;
    if (open) { emitted.push(piece); continue; }
    const gate = scaffoldStreamGate(acc);
    if (gate.action === "flush") { open = true; if (gate.text) emitted.push(gate.text); }
  }
  assert.equal(emitted.join("").trim(), "只剩 5 个待接入。", "only the reply streams");
}

// 13. RED LINE: widening the file-line matcher to quoted paths must never eat a
// real reply. A reply may legitimately OPEN with a quoted path ("`/etc/hosts`
// 里少了一行"); only a BULLETED line may use the quoted form, because that is how
// these templates write file lists.
{
  const scaffold = [
    "## Objective", "- 目标", "## Important Details", "- 细节",
    "## Work State", "### Completed", "- 完成", "## Next Move", "1. 下一步",
    "## Relevant Files", "- `/Users/a/one.js`：说明", "- `backend/caps.js`：说明",
  ].join("\n");
  const replies = [
    "`/etc/hosts` 里少了一行，补上即可。",
    "\"/etc/hosts\" 少了一行。",
    "「/etc/hosts」少了一行。",
    "（详见 /Users/a/report.md）原因是缓存没刷新。",
    "(see /Users/a/report.md) the cache was stale.",
    "`config.json` 写错了。",
    "只剩 5 个待接入。",
  ];
  for (const reply of replies) {
    const strip = stripStatusScaffoldPrefix(`${scaffold}\n\n${reply}`);
    assert.equal(strip.text, reply, `a real reply must survive: ${reply}`);
    assert.equal(strip.pure, false, `and must never be replaced by the note: ${reply}`);
  }
  // The bulleted file list itself is still recognised as scaffold body.
  assert.equal(stripStatusScaffoldPrefix(scaffold).pure, true, "a pure quoted file list is still scaffold");
}

console.log("status-scaffold: ok");
