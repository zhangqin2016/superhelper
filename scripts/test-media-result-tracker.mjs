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
const { sweep, extractPaths, GRACE_MS } = require("../src/main/media-result-tracker.js");

function assert(c, m) { if (!c) throw new Error(m); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-media-track-"));
const resultsDir = path.join(root, "generated-assets", ".lily-results");
fs.mkdirSync(resultsDir, { recursive: true });

const VIDEO = '<generated_media type="video">\n  <file path="' + root + '/generated-assets/v1.mp4" bytes="2168000" />\n</generated_media>\n';

function writeRecord(name, { createdAt, content = VIDEO, type = "video" }) {
  fs.writeFileSync(path.join(resultsDir, name), JSON.stringify({ type, provider: "volcengine", taskId: "t1", content, createdAt }));
}
function makeCtx(conversation = []) {
  const injected = [];
  return {
    injected,
    projectManager: { projects: [{ id: "p1", path: root }] },
    sessionManager: {
      activeSessionId: "s1",
      findById: (id) => (id === "s1" ? { id: "s1", projectId: "p1" } : null),
      listForProject: () => [{ id: "s1" }],
      getConversation: () => conversation,
    },
    turnOrchestrator: {
      completeLocalAssistantTurn: (sessionId, text, files, opts) => { injected.push({ sessionId, text, assistant: opts?.assistant }); return { ok: true }; },
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

fs.rmSync(root, { recursive: true, force: true });
console.log("test-media-result-tracker: ALL_OK");
