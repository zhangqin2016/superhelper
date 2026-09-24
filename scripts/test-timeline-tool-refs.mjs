#!/usr/bin/env node
/**
 * A reopened turn shows every step it took, at no extra size.
 *
 * The archived timeline kept its last 100 entries — 29% of records with a
 * timeline had hit that cap, so a long turn reopened without its first steps.
 * The cap was paying for duplication: each timeline tool entry copied the
 * input and result already in `record.tools` (5,265/5,272 identical inputs
 * over 200 real records, 67% of timeline bytes). Tool entries are now stored
 * and sent as references and made whole where they are read; the cap is gone.
 * Verified on 909 real records: every one round-trips deep-equal.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const refs = await import("../src/shared/timeline-tool-refs.mjs");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

const tool = (i) => ({ id: `call_${i}`, name: "bash", status: "done", input: { command: `step ${i}` }, result: `output of step ${i} `.repeat(40) });
function recordWith(steps) {
  const tools = Array.from({ length: steps }, (_, i) => tool(i));
  const timeline = [];
  tools.forEach((t, i) => {
    timeline.push({ kind: "text", id: `text_${i + 1}`, text: `第 ${i} 步`, status: "done" });
    timeline.push({ kind: "tool", ...t, preview: `Bash step ${i}`, partialJson: "" });
  });
  return { turnId: "t", assistantText: "done", tools, timeline };
}

// ------------------------------------------------------------- lossless
{
  const record = recordWith(3);
  const stored = refs.dehydrateTimelineTools(record);
  const entry = stored.timeline.find((e) => e.kind === "tool");
  assert.deepEqual(entry.toolRef, ["input", "result"], "the entry names what it left with its tool");
  assert.equal("result" in entry, false);
  assert.deepEqual(refs.rehydrateTimelineTools(JSON.parse(JSON.stringify(stored))), record, "and reads back exactly");
  assert.equal(record.timeline[1].result.length > 0, true, "the caller's record is never mutated");
  assert.equal(refs.dehydrateTimelineTools(stored), stored, "storing twice changes nothing");
  check("a timeline tool entry is stored as a reference and read back exactly, without touching the caller's record");
}

{
  // Only an exactly equal field becomes a reference.
  const record = recordWith(1);
  record.timeline[1].result = "a different result than the tool's";
  const stored = refs.dehydrateTimelineTools(record);
  assert.deepEqual(stored.timeline[1].toolRef, ["input"], "a field that differs is kept as it is");
  assert.equal(stored.timeline[1].result, "a different result than the tool's");
  const orphan = { ...recordWith(1), tools: [] };
  assert.equal(refs.dehydrateTimelineTools(orphan), orphan, "an entry whose tool is missing is kept whole");
  const plain = { timeline: [{ kind: "text", text: "x" }] };
  assert.equal(refs.rehydrateTimelineTools(plain), plain, "a record without references is returned untouched");
  check("only exactly equal fields become references; differing data and missing tools stay whole");
}

// -------------------------------------------------- stored, read, sent, shown
{
  const { pack, unpack } = require("../src/main/store/message-envelope.js");
  const message = { id: "m", role: "assistant", record: recordWith(5) };
  const blob = pack(message);
  assert.deepEqual(unpack(blob), message, "every reader of a stored record sees it whole");

  const { projectMessageForDisplay } = require("../src/main/conversation-display-projection.js");
  const sent = projectMessageForDisplay(unpack(blob));
  assert.ok(sent.record.timeline.filter((e) => e.kind === "tool").every((e) => Array.isArray(e.toolRef)), "sent to the renderer as references");
  // IPC carries uncompressed JSON, so this is the size that matters there
  // (gzip on disk already folds the duplicate; 8% on real records).
  assert.ok(JSON.stringify(sent).length < JSON.stringify(message).length * 0.7, "what crosses IPC is much smaller than the duplicated form");

  const { timelineFromRecord } = await import("../src/renderer/modules/turn-record-timeline.js");
  const shown = timelineFromRecord(JSON.parse(JSON.stringify(sent.record)));
  assert.deepEqual(shown, message.record.timeline, "and whole again where the renderer builds the timeline");
  check("stored and sent as references, whole wherever it is read or shown");
}

// ------------------------------------------------------------- no cap
{
  const { TurnArchive } = require("../src/main/turn-archive.js");
  const archive = new TurnArchive({ findById: () => null });
  const steps = recordWith(180);
  const state = {
    turnId: "t_long", tools: new Map(steps.tools.map((t) => [t.id, t])), timeline: steps.timeline,
    notices: [], contentBlocks: [], processEvents: [], assistantText: "done",
  };
  const record = archive.buildRecord(state, "turn.completed", { assistant: "done" });
  assert.equal(record.timeline.length, 360, "a 180-step turn keeps all 360 timeline entries, not its last 100");
  assert.equal(record.timeline[0].text, "第 0 步", "including how it began");
  assert.notEqual(record.timeline, state.timeline, "as a copy, not the live array");
  check("an archived turn keeps its whole timeline");
}

console.log(`timeline-tool-refs: ok (${checks} checks)`);
