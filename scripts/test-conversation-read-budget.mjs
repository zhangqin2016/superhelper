#!/usr/bin/env node
// Opening or continuing a conversation costs the page, not the session.
//
// Field report (2026-09-19): a session with 1,000+ messages took seconds to
// open. Measured on a real 365-message session (and a 1,460-message copy):
//   - every hot-path reader called getConversation() — the WHOLE session,
//     gunzip + parse of every envelope: 565 ms per call at 1,460 messages —
//     for a tail of 12 (media dedupe), the first user message (resume binding),
//     the last 8 user texts (resume continuity), or sixty turns (turn intent),
//     and once more on every open whose engine runner was alive;
//   - a page of 50 messages was 13.6 MB of JSON, 66% of it raw process-event
//     payloads (whole stdout chunks) the process panel never renders.
// Now every hot-path reader takes a bounded tail (82 ms / 0 ms / 14 ms), and
// process events are compacted at archive time and, for older records, on
// read (13.6 → 5.6 MB per page). [gate: conversation-read-budget]
// Run: node scripts/test-conversation-read-budget.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { MessageStore } = require("../src/main/store/message-store.js");
const { projectMessageForDisplay, projectConversationForDisplay, compactProcessEvents } = require("../src/main/conversation-display-projection.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-budget-"));
try {
  const store = new MessageStore(path.join(dir, "messages.db"), path.join(dir, "blobs"));
  const sid = "s-budget";
  for (let i = 1; i <= 300; i += 1) {
    store.append(sid, { id: `m${i}`, role: i % 2 ? "user" : "assistant", content: `message ${i}`, timestamp: new Date(1700000000000 + i * 1000).toISOString() });
  }

  check("the bounded reads answer without unpacking the session", () => {
    assert.equal(store.count(sid), 300);
    assert.equal(store.getFirstUserMessage(sid)?.content, "message 1", "the first user message by index, not by scan");
    const tail = store.getPage(sid, { limit: 12 }).conversation;
    assert.equal(tail.length, 12); assert.equal(tail[0].content, "message 289"); assert.equal(tail[11].content, "message 300", "chronological tail");
    assert.equal(store.getFirstUserMessage("nobody"), null);
  });

  check("a page carries what the process panel shows, not the stdout it never renders", () => {
    const fat = Array.from({ length: 100 }, (_, i) => ({
      rawType: "process", rawSubtype: "stdout", summary: `step ${i}`, handled: true,
      event: { chunk: "x".repeat(20_000) },
      effects: Array.from({ length: 20 }, (_, j) => ({ kind: "tool", id: `t${j}`, name: `tool-${j}`, text: "y".repeat(5_000), result: "z".repeat(5_000) })),
    }));
    const message = { id: "m", role: "assistant", record: { turnId: "t", processEvents: fat, assistantText: "done" } };
    const rawBytes = JSON.stringify(message).length;
    const projected = projectMessageForDisplay(message);
    const projectedBytes = JSON.stringify(projected).length;
    assert.ok(projectedBytes < rawBytes * 0.05, `compact form is a fraction of the raw one: ${projectedBytes} vs ${rawBytes}`);
    assert.equal(projected.record.processEvents.length, 100, "every event is still there");
    assert.equal(projected.record.processEvents[3].summary, "step 3", "with its summary line");
    assert.equal(projected.record.processEvents[3].effects[0].name, "tool-0", "and its effects");
    assert.equal(projected.record.processEvents[3].effects.length, 8, "capped as the live panel already caps them");
    assert.equal(message.record.processEvents[0].event.chunk.length, 20_000, "the stored record is never mutated");
    assert.equal(projectMessageForDisplay(projected), projected, "an already compact record passes through by identity");
    assert.equal(projectMessageForDisplay({ id: "u", role: "user", content: "hi" }).content, "hi");
    assert.equal(projectConversationForDisplay(null), null);
    assert.deepEqual(compactProcessEvents([]), []);
  });

  check("new records are archived compact, and the page projection is wired into the read path", () => {
    const archive = fs.readFileSync(path.join(ROOT, "src/main/turn-archive.js"), "utf8");
    assert.match(archive, /processEvents: compactProcessEvents\(\(state\.processEvents \|\| \[\]\)\.slice\(-100\)\)/, "archive time");
    const manager = fs.readFileSync(path.join(ROOT, "src/main/session-manager.js"), "utf8");
    assert.match(manager, /conversation: projectConversationForDisplay\(fresh\.conversation\)/, "read time, for records archived before");
  });

  check("no hot-path reader unpacks the whole session", () => {
    const hot = ["turn-intelligence.js", "opencode-conversation-source.js", "media-result-tracker.js", "ipc-agent-runtime.js", "resume-binding.js", "resume-continuity-guard.js", "turn-orchestrator.js", "send-preflight.js", "turn-terminal-finalizer.js", "turn-recovery-runtime.js", "turn-dispatch-runtime.js"];
    const offenders = [];
    for (const name of hot) {
      const src = fs.readFileSync(path.join(ROOT, "src/main", name), "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (!/\bgetConversation\(/.test(line)) continue;
        // A guarded fallback for a stand-in session manager without the
        // bounded read is fine; a plain call is the 565 ms.
        if (/getRecentConversation|getFirstUserMessage/.test(line)) continue;
        if (/typeof .*getConversation === "function"/.test(line)) continue;
        if (/^\s*\?|^\s*:/.test(line) && /getConversation\(/.test(line)) continue;
        offenders.push(`${name}:${i + 1}`);
      }
    }
    assert.deepEqual(offenders, [], `hot paths read a tail (getRecentConversation) or one message (getFirstUserMessage):\n${offenders.join("\n")}`);
  });

  console.log(`\n${checks} checks passed (conversation read budget)`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
