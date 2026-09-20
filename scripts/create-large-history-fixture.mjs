import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store");
const targetGiB = Number(process.env.LILY_STRESS_DB_GIB || 0);
if (!Number.isFinite(targetGiB) || targetGiB < 0 || targetGiB > 8) throw new Error("LILY_STRESS_DB_GIB must be between 0 and 8");
const targetBytes = targetGiB * 1024 ** 3;
const maxRecords = targetBytes ? Math.ceil(targetBytes / (512 * 1024)) * 2 : 1600;
const container = fs.mkdtempSync(path.join(os.tmpdir(), "lily-native-large-history-"));
// Migration scans the profile's parent as well as APPDATA/LOCALAPPDATA.
// A dedicated parent keeps neighboring fixtures out of that scan.
const root = path.join(container, "profile");
fs.mkdirSync(root);
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const smallId = crypto.randomUUID();
const now = new Date().toISOString();
const store = new MessageStore(path.join(root, "messages.db"), path.join(root, "blobs"));
let records = 0;
try {
  for (let i = 0; i < maxRecords; i++) {
    store.append(sessionId, { id: `synthetic-${i}`, role: "assistant", content: `Synthetic history ${i}: calculation checked.`, record: {
      assistantText: `Synthetic history ${i}: calculation checked.`,
      processEvents: [{ summary: `Synthetic tool output ${i}`, event: { chunk: crypto.randomBytes(512 * 1024).toString("base64") } }],
    } });
    records++;
    if (records % 100 === 0) {
      const bytes = store.db.pragma("page_count") * store.db.pragma("page_size");
      console.log(JSON.stringify({ records, databaseMiB: Math.round(bytes / 1048576), targetGiB }));
      if (targetBytes && bytes >= targetBytes) break;
    }
  }
  store.append(sessionId, { id: "synthetic-giant", turnId: "synthetic-recovery-turn", role: "assistant", content: "Large-history fixture ready. No real customer records.", record: {
    assistantText: "Large-history fixture ready. No real customer records.",
    processEvents: Array.from({ length: 128 }, () => ({ summary: "Synthetic diagnostic payload", event: { chunk: "x".repeat(1024 * 1024) } })),
  } });
  store.append(smallId, { id: "small", role: "user", content: "Small-history control session." });
} finally { await store.close(); }
const sessions = [
  { id: sessionId, title: `STRESS ${records + 1} - Large History`, messageCount: records + 1 },
  { id: smallId, title: "STRESS Control", messageCount: 1 },
].map(s => ({ ...s, projectId, status: "idle", createdAt: now, updatedAt: now }));
fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ activeProjectId: projectId, workspaceOrderVersion: 1, projects: [{ id: projectId, name: "STRESS ISOLATED", path: workspace, createdAt: now }] }));
fs.writeFileSync(path.join(root, "sessions-index.json"), JSON.stringify({ activeSessionId: sessionId, sessions: { [projectId]: sessions } }));
const databaseBytes = fs.statSync(path.join(root, "messages.db")).size;
if (databaseBytes < targetBytes) throw new Error("Generated database did not reach target size");
console.log(JSON.stringify({ profile: root, sessionId, smallId, records: records + 1, databaseBytes }));
