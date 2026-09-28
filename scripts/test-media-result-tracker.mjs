#!/usr/bin/env node
// Closed-loop guard for the background media-result tracker: an orphaned generation
// (skill finished + dropped a result record after the turn died) gets surfaced into the
// session exactly once; a result the live turn already showed is deduped; fresh records
// wait out the grace window. (CAPABILITY-GATE: media never silently lost or doubled.)

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { sweep, extractPaths, alreadyShown, sessionForProject, mediaResultsInbox, GRACE_MS, INBOX_ORPHAN_MS } = require("../src/main/media-result-tracker.js");

function assert(c, m) { if (!c) throw new Error(m); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-media-track-"));
const resultsDir = path.join(root, "generated-assets", ".lily-results");
fs.mkdirSync(resultsDir, { recursive: true });

const VIDEO = '<generated_media type="video">\n  <file path="' + root + '/generated-assets/v1.mp4" bytes="2168000" />\n</generated_media>\n';

function writeRecord(name, { createdAt, content = VIDEO, type = "video" }) {
  fs.writeFileSync(path.join(resultsDir, name), JSON.stringify({ type, provider: "volcengine", taskId: "t1", content, createdAt }));
}
function makeCtx(conversation = [], snapshot = { phase: "idle", queueLength: 0 }) {
  const injected = [];
  const stored = new Map();
  return {
    injected,
    eventBus: { emit: (sessionId, event) => injected.push({ sessionId, assistant: event.payload.committedMessage.content, event }) },
    projectManager: { projects: [{ id: "p1", path: root }] },
    sessionManager: {
      activeSessionId: "s1",
      findById: (id) => (id === "s1" ? { id: "s1", projectId: "p1" } : null),
      listForProject: () => [{ id: "s1" }],
      getConversation: () => conversation,
      findMessage: (_s, id) => stored.get(id),
      pushMessageTo: (_s, role, content, _files, extra) => stored.set(extra.id, { role, content, ...extra }),
    },
    turnOrchestrator: {
      snapshot: () => snapshot,
      completeLocalAssistantTurn: () => { throw new Error("Media must not create a task"); },
    },
  };
}

// extractPaths
assert(extractPaths(VIDEO)[0].endsWith("v1.mp4"), "extractPaths pulls the file path");

// 1. Orphaned (old record, not yet shown) -> injected once + record deleted.
writeRecord("old.json", { createdAt: Date.now() - GRACE_MS - 1000 });
let ctx = makeCtx([]);
sweep(ctx);
assert(ctx.injected.length === 1, `orphaned result should be injected once, got ${ctx.injected.length}`);
assert(ctx.injected[0].sessionId === "s1", "injected into the project's session");
assert(String(ctx.injected[0].assistant).includes("v1.mp4"), "injected content carries the generated_media");
assert(fs.readdirSync(resultsDir).length === 0, "record deleted after surfacing");
console.log("media-tracker: orphaned result surfaced + cleared ok");

// 2. Dedup — live turn already showed this path -> NOT injected, record deleted.
writeRecord("dup.json", { createdAt: Date.now() - GRACE_MS - 1000 });
ctx = makeCtx([{ role: "assistant", content: `here it is ${root}/generated-assets/v1.mp4` }]);
sweep(ctx);
assert(ctx.injected.length === 0, "already-shown media must not be re-injected");
assert(fs.readdirSync(resultsDir).length === 0, "deduped record still deleted");
console.log("media-tracker: dedup vs live turn ok");

// 3. Grace window — fresh record is left for the live turn to show first.
writeRecord("fresh.json", { createdAt: Date.now() });
ctx = makeCtx([]);
sweep(ctx);
assert(ctx.injected.length === 0, "fresh record must wait out the grace window");
assert(fs.readdirSync(resultsDir).length === 1, "fresh record kept for a later sweep");
console.log("media-tracker: grace window ok");

// 4. Busy session — old fallback media waits instead of becoming a queued composer message.
writeRecord("busy.json", { createdAt: Date.now() - GRACE_MS - 1000 });
ctx = makeCtx([], { phase: "tool_running", queueLength: 0 });
sweep(ctx);
assert(ctx.injected.length === 0, "busy session must not receive fallback media as a queued message");
assert(fs.readdirSync(resultsDir).length === 2, "busy fallback record kept for idle sweep");
ctx = makeCtx([], { phase: "idle", queueLength: 0 });
sweep(ctx);
assert(ctx.injected.length === 1, "idle session should receive deferred fallback media");
assert(fs.readdirSync(resultsDir).length === 1, "deferred fallback record deleted after surfacing");
console.log("media-tracker: busy session defers fallback media ok");

const winPath = "D:\\work\\generated-assets\\image.png";
assert(alreadyShown(makeCtx([{ role: "assistant", content: winPath }]), "s1", [winPath]), "Windows path dedup");
assert(!alreadyShown(makeCtx([{ role: "user", content: winPath }]), "s1", [winPath]), "A user mention is not delivery");
assert(!alreadyShown(makeCtx([{ role: "assistant", content: winPath + ".backup" }]), "s1", [winPath]), "A filename prefix is not delivery");
assert(alreadyShown(makeCtx([{ role: "assistant", content: winPath.toLowerCase() }]), "s1", [winPath]), "Windows path case is equivalent");
assert(!alreadyShown(makeCtx([{ role: "assistant", content: winPath }]), "s1", [winPath, "D:/other.png"]), "Every image must be delivered");
const winMarker = `<generated_media type="image">\n  <file path="${winPath}" bytes="1" />\n</generated_media>\n`;
assert(alreadyShown(makeCtx([{ role: "assistant", record: { tools: [{ status: "done", result: { content: winMarker } }] } }]), "s1", [winPath]), "A marker in tool output is what the renderer shows: deduped");
// A tool output that only mentions the path did not show the media: a later
// listing, or the skill's own output with the marker cut off by `| tail -2`.
assert(!alreadyShown(makeCtx([{ role: "assistant", record: { tools: [{ status: "done", result: { content: `./generated-assets/x\n${winPath}\n` } }] } }]), "s1", [winPath]), "A listing is not delivery");
assert(!alreadyShown(makeCtx([{ role: "assistant", record: { tools: [{ status: "done", result: { content: `  <file path="${winPath}" bytes="1" />\n</generated_media>\n` } }] } }]), "s1", [winPath]), "A marker cut by tail is not delivery");
assert(alreadyShown(makeCtx([{ role: "assistant", record: { tools: [{ status: "done", result: JSON.stringify({ content: winMarker }) }] } }]), "s1", [winPath]), "A JSON-encoded tool result with a marker is delivery");
ctx = makeCtx();
ctx.sessionManager.listForProject = () => [{ id: "s1" }, { id: "s2" }];
assert(sessionForProject(ctx, { id: "p1" }, {}) === null, "Do not guess ownership from active tab");
assert(sessionForProject(ctx, { id: "p1" }, { sessionId: "s1" }) === "s1", "Explicit owner wins");
writeRecord("retry.json", { createdAt: Date.now() - GRACE_MS - 1000 });
ctx = makeCtx();
ctx.sessionManager.pushMessageTo = () => { throw new Error("disk unavailable"); };
sweep(ctx);
assert(fs.existsSync(path.join(resultsDir, "retry.json")), "Persistence failure keeps receipt");
ctx = makeCtx();
sweep(ctx);
assert(ctx.injected[0].event.turnId === null, "Supplement is not a turn");
assert(!ctx.injected[0].event.payload.committedMessage.record?.user, "Supplement has no synthetic user");
writeRecord("event-retry.json", { createdAt: Date.now() - GRACE_MS - 1000 });
ctx = makeCtx();
const emit = ctx.eventBus.emit;
ctx.eventBus.emit = () => { throw new Error("event unavailable"); };
sweep(ctx);
assert(fs.existsSync(path.join(resultsDir, "event-retry.json")), "Event failure retains receipt");
ctx.eventBus.emit = emit;
sweep(ctx);
assert(ctx.injected.length === 1, "Persisted supplement can be re-emitted without another task");
console.log("media-tracker: Windows, ownership, partial delivery and durable failure regressions ok");

// 5. Host inbox: a generation whose output_dir (or a `cd`) put it outside
//    <workspace>/generated-assets is still found, owned by the workspace that
//    contains the file, delivered once, and the receipt cleared. Field case
//    2026-09-28: output/capability-gauntlet/generated-assets/.lily-results sat
//    unswept for 38 minutes.
{
  const inbox = mediaResultsInbox(path.join(root, "userData"));
  fs.mkdirSync(inbox, { recursive: true });
  const nested = path.join(root, "output", "gauntlet", "generated-assets", "cover.png");
  const content = `<generated_media type="image">\n  <file path="${nested}" bytes="9" />\n</generated_media>\n`;
  fs.writeFileSync(path.join(inbox, "a.json"), JSON.stringify({ type: "image", content, createdAt: Date.now() - GRACE_MS - 1000 }));
  // The live turn cut the marker off (`| tail -2`): the path is in tool output, the media was never shown.
  ctx = makeCtx([{ role: "assistant", content: "封面已生成", record: { tools: [{ status: "done", result: { content: `  <file path="${nested}" bytes="9" />\n</generated_media>\n` } }] } }]);
  sweep(ctx, Date.now(), { inbox });
  assert(ctx.injected.length === 1, `marker-cut generation must be delivered from the inbox, got ${ctx.injected.length}`);
  assert(String(ctx.injected[0].assistant).includes("cover.png"), "delivered content carries the marker");
  assert(fs.readdirSync(inbox).length === 0, "inbox receipt cleared after delivery");
  sweep(ctx, Date.now(), { inbox });
  assert(ctx.injected.length === 1, "delivered once");

  // A record no workspace owns waits, then is dropped (with a log) after the orphan window.
  const outside = path.join(os.tmpdir(), "not-a-workspace", "generated-assets", "x.png");
  const orphan = `<generated_media type="image">\n  <file path="${outside}" bytes="1" />\n</generated_media>\n`;
  fs.writeFileSync(path.join(inbox, "o.json"), JSON.stringify({ type: "image", content: orphan, createdAt: Date.now() - GRACE_MS - 1000 }));
  ctx = makeCtx([]);
  sweep(ctx, Date.now(), { inbox });
  assert(ctx.injected.length === 0 && fs.existsSync(path.join(inbox, "o.json")), "an unowned record waits");
  const warn = console.warn; const warnings = []; console.warn = (m) => warnings.push(String(m));
  try { sweep(ctx, Date.now() + INBOX_ORPHAN_MS + 1, { inbox }); } finally { console.warn = warn; }
  assert(!fs.existsSync(path.join(inbox, "o.json")), "an unowned record is dropped after the orphan window");
  assert(warnings.some((m) => m.includes("no workspace owns")), "the drop is logged");
  console.log("media-tracker: host inbox, marker-cut delivery and orphan expiry ok");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("test-media-result-tracker: ALL_OK");
