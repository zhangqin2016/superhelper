// Unit test for the SQLite-backed MessageStore + blob externalization.
// Run: node scripts/test-message-store.mjs  (node:sqlite is built in to Node 22.5+/Electron 41)
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");

let passed = 0;
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) passed += 1;
  else fail(msg);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msgstore-"));
const dbPath = path.join(tmp, "messages.db");
const blobDir = path.join(tmp, "blobs");

// ~600KB base64 data URL — must be externalized to a blob (dedupe two copies).
const bigThumb = "data:image/png;base64," + "A".repeat(600 * 1024);
const smallIcon = "data:image/svg+xml;base64," + "B".repeat(100); // stays inline

try {
  const store = new MessageStore(dbPath, blobDir);

  // --- append a user message with a heavy thumbnail ---
  const userMsg = {
    id: "msg_u1",
    role: "user",
    content: "hello with image",
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    record: {
      turnId: "t1",
      user: { text: "hello", files: [{ name: "a.png", isImage: true, thumbnail: bigThumb }] },
    },
  };
  store.append("S1", userMsg);

  // assistant turn that reuses the SAME thumbnail (dedupe) + a small inline icon
  store.append("S1", {
    id: "msg_a1",
    role: "assistant",
    timestamp: new Date("2026-01-01T00:01:00Z").toISOString(),
    record: {
      turnId: "t1",
      assistantText: "answer one",
      totalCostUsd: 0.012,
      durationMs: 3400,
      terminal: "turn.completed",
      icon: smallIcon,
      dupThumb: bigThumb,
    },
  });

  ok(store.count("S1") === 2, "count should be 2");

  // --- externalization: big thumb gone from stored bytes, small icon inline ---
  const page = store.getPage("S1", {});
  ok(page.conversation.length === 2, "page returns 2 messages");
  const u = page.conversation[0];
  const a = page.conversation[1];
  ok(u.content === "hello with image", "user content round-trips");
  const thumbRef = u.record.user.files[0].thumbnail;
  ok(thumbRef && thumbRef.__blobRef, "thumbnail replaced by blob ref");
  ok(thumbRef.mime === "image/png", "ref keeps mime");
  ok(typeof a.record.icon === "string" && a.record.icon.startsWith("data:"), "small icon stays inline");
  ok(a.record.assistantText === "answer one", "assistant text round-trips");

  // dedupe: both messages reference the same hash → one blob file, one catalog row
  const hash = thumbRef.__blobRef;
  ok(a.record.dupThumb.__blobRef === hash, "duplicate thumbnail dedupes to same hash");
  ok(store.blobs.exists(hash), "blob bytes written to disk");
  const refRow = store.db.get("SELECT refcount FROM blobs WHERE hash=?", hash);
  ok(refRow.refcount === 2, `blob refcount should be 2, got ${refRow?.refcount}`);

  // --- keyset pagination ---
  for (let i = 0; i < 5; i += 1) {
    store.append("S2", {
      id: `m${i}`,
      role: "user",
      content: `msg ${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
    });
  }
  const p1 = store.getPage("S2", { limit: 2 });
  ok(p1.conversation.map((m) => m.content).join(",") === "msg 3,msg 4", "newest page = last 2 chronological");
  ok(p1.hasMore === true, "hasMore true after newest page");
  const p2 = store.getPage("S2", { before: p1.nextBefore, limit: 2 });
  ok(p2.conversation.map((m) => m.content).join(",") === "msg 1,msg 2", "older page = msg 1,2");
  const p3 = store.getPage("S2", { before: p2.nextBefore, limit: 2 });
  ok(p3.conversation.map((m) => m.content).join(",") === "msg 0", "oldest page = msg 0");
  ok(p3.hasMore === false, "hasMore false at start");

  // --- getAll order ---
  ok(store.getAll("S2").map((m) => m.content).join(",") === "msg 0,msg 1,msg 2,msg 3,msg 4", "getAll chronological");

  // --- removeLast respects role ---
  ok(store.removeLast("S2", "assistant") === false, "removeLast(assistant) no-op when last is user");
  ok(store.removeLast("S2", "user") === true, "removeLast(user) removes");
  ok(store.count("S2") === 4, "count after removeLast is 4");

  // --- FTS search ---
  const hits = store.search("answer");
  ok(hits.length === 1 && hits[0].id === "msg_a1", "FTS finds assistant message");

  // --- GC: clearing S1 drops refcount; blob removed when it hits 0 ---
  store.clear("S1");
  ok(store.count("S1") === 0, "S1 cleared");
  ok(!store.blobs.exists(hash), "blob file GC'd after last ref removed");
  ok(!store.db.get("SELECT 1 FROM blobs WHERE hash=?", hash), "blob catalog row GC'd");

  // --- deleteFromTurn: rewind truncation (the turn + everything after) ---
  for (const t of ["t1", "t2", "t3"]) {
    store.append("S3", { id: `${t}_u`, role: "user", content: `${t} user`, turnId: t });
    store.append("S3", { id: `${t}_a`, role: "assistant", content: `${t} reply`, turnId: t });
  }
  ok(store.count("S3") === 6, "S3 seeded with 3 turns (6 messages)");
  ok(store.deleteFromTurn("S3", "t2") === 4, "deleteFromTurn(t2) removes t2 + t3 (4 messages)");
  ok(store.count("S3") === 2, "only t1 remains after rewind to t2");
  ok(store.getAll("S3").every((m) => m.content.startsWith("t1")), "remaining messages are all t1");
  ok(store.deleteFromTurn("S3", "nope") === 0, "deleteFromTurn on unknown turn is a no-op");

  // --- persistence across reopen ---
  store.close();
  const store2 = new MessageStore(dbPath, blobDir);
  ok(store2.count("S2") === 4, "data persists across reopen");
  store2.close();

  console.log(`\nmessage-store: ${passed} checks passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
