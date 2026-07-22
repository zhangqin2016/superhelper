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
  assert.equal(scaffoldStreamGate("Obj").action, "flush", "a non-header first line can never become scaffold");
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

console.log("status-scaffold: ok");
