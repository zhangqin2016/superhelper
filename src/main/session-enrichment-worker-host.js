"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { applyEnrichmentCommit } = require("./store/message-enrichment-commit");

function startEnrichmentWorker({ store, sessions, workspacePathFor, versions, onProgress }) {
  if (process.env.LILY_SESSION_ENRICHMENT === "0") return null;
  const worker = new Worker(path.join(__dirname, "store", "message-enrichment-worker.js"), {
    workerData: { filePath: store.db.filePath, versions, sessions: sessions.map(s => ({
      id: s.id, updatedAt: s.updatedAt, createdAt: s.createdAt, workspacePath: workspacePathFor(s),
    })) },
  });
  let stopped = false;
  worker.on("message", event => {
    if (stopped) return;
    if (event.type === "commit") {
      try { worker.postMessage({ commitId: event.commitId, result: applyEnrichmentCommit(store.db.raw, event.change) }); }
      catch (error) { worker.postMessage({ commitId: event.commitId, error: { message: error.message, code: error.code } }); }
      return;
    }
    if (event.type === "progress") {
      try { onProgress?.(event); } catch { /* A progress listener cannot stop maintenance. */ }
    } else if (event.type === "warning" || event.type === "error") {
      console.warn("[sessions] worker enrichment deferred:", event.sessionId || "", event.error);
    } else if (event.type === "done") {
      console.info("[sessions] worker enrichment completed:", event);
      try { onProgress?.({ phase: "done", kind: "enrichment", done: event.scanned, total: event.total }); } catch {}
    }
  });
  worker.on("error", error => console.warn("[sessions] enrichment worker failed:", error.message));
  worker.on("exit", code => {
    if (!stopped && code !== 0) console.warn("[sessions] enrichment worker exited:", code);
  });
  worker.unref();
  return { stop() { stopped = true; return worker.terminate(); } };
}

module.exports = { startEnrichmentWorker };
