import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(import.meta.url);
const { createMessageReadMethods } = require("../src/main/store/message-read-store");
const { MessageReadWorker } = require("../src/main/store/message-read-worker-client");
const { TranscriptStore } = require("../src/main/transcript-store");
const [filePath, sessionId] = process.argv.slice(2);
if (!filePath || !sessionId) throw new Error("Usage: node --expose-gc benchmark-history-recovery.mjs <database> <session>");
const db = new DatabaseSync(filePath, { readOnly: true });
const reader = new MessageReadWorker(filePath);
const turnId = db.prepare("SELECT turn_id FROM messages WHERE session_id=? AND role='assistant' AND turn_id IS NOT NULL ORDER BY seq DESC LIMIT 1").get(sessionId)?.turn_id;
if (!turnId) throw new Error("Fixture needs an assistant turn");
const fullRead = () => createMessageReadMethods().getAll.call({ db: { all: (sql, ...args) => db.prepare(sql).all(...args) } }, sessionId);
// Only benchmark selection; never mutate the database or mark a real turn.
const updateMessageMeta = (_session, id, update) => ({ id, meta: update({}) });
const recover = manager => new TranscriptStore({ ...manager, updateMessageMeta }).supersedeAssistantTurn(sessionId, turnId, "benchmark-no-write");
async function measure(name, read) {
  let last = performance.now(), gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
  try {
    await delay(30);
    const start = performance.now();
    const result = await read();
    const elapsed = performance.now() - start;
    const memory = process.memoryUsage();
    await delay(30);
    console.log(JSON.stringify({ name, elapsedMs: Math.round(elapsed), maxHeartbeatGapMs: Math.round(gap), rssMiB: Math.round(memory.rss / 1048576), heapMiB: Math.round(memory.heapUsed / 1048576), selected: !!result, pageMessages: result?.conversation?.length, total: result?.total }));
    return result;
  } finally { clearInterval(timer); }
}
try {
  const before = await measure("full-history-recovery-baseline", () => recover({ getConversation: fullRead }));
  global.gc?.();
  const after = await measure("indexed-worker-recovery", () => recover({ getAssistantForTurnAsync: (...args) => reader.assistantForTurn(...args), getConversation() { throw new Error("FULL_SCAN_FORBIDDEN"); } }));
  if (before?.id !== after?.id) throw new Error("Selection changed");
  for (const limit of [50, 120]) await measure(`worker-page-${limit}`, () => reader.page(sessionId, { limit }));
} finally { await reader.close(); db.close(); }
