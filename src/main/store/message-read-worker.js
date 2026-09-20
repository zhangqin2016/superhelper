"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { unpack } = require("./message-envelope");
const { projectMessageForDisplay } = require("../conversation-display-projection");
const { withFreshArtifacts } = require("../artifact-freshness");
const db = new DatabaseSync(workerData.filePath, { readOnly: true });
db.exec("PRAGMA busy_timeout=5000");

parentPort.on("message", ({ id, operation = "page", sessionId, opts = {} }) => {
  try {
    if (operation === "userRevisionsForTurn") {
      const value = [];
      for (const row of db.prepare("SELECT envelope_blob FROM messages WHERE session_id=? AND turn_id=? AND role='user' ORDER BY seq ASC").iterate(sessionId, opts.turnId)) {
        const message = unpack(row.envelope_blob);
        if (message?.turnId === opts.turnId && message?.meta?.steer === true) {
          value.push({ turnId: opts.turnId, steerSeq: message.meta.steerSeq, text: String(message.content || ""), files: message.files || [] });
        }
      }
      parentPort.postMessage({ id, value });
      return;
    }
    if (operation === "assistantForTurn") {
      let value = null;
      for (const row of db.prepare("SELECT envelope_blob FROM messages WHERE session_id=? AND turn_id=? AND role='assistant' ORDER BY seq DESC").iterate(sessionId, opts.turnId)) {
        const message = unpack(row.envelope_blob);
        if (message?.turnId === opts.turnId && !message?.meta?.superseded) { value = { id: message.id }; break; }
      }
      parentPort.postMessage({ id, value });
      return;
    }
    // One consistent WAL snapshot; inflate/project one row before reading the next.
    db.exec("BEGIN");
    const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
    const before = Number.isInteger(opts.before) ? opts.before : null;
    const total = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id=?").get(sessionId).n;
    const sql = `SELECT seq,envelope_blob FROM messages WHERE session_id=? ${before === null ? "" : "AND seq < ?"} ORDER BY seq DESC LIMIT ?`;
    const args = before === null ? [sessionId, limit] : [sessionId, before, limit];
    const conversation = [];
    let minSeq = 0;
    for (const row of db.prepare(sql).iterate(...args)) {
      const message = unpack(row.envelope_blob);
      const fresh = opts.workspacePath ? withFreshArtifacts([message], opts.workspacePath).conversation[0] : message;
      conversation.push(projectMessageForDisplay(fresh));
      minSeq = row.seq;
    }
    const hasMore = Boolean(minSeq && db.prepare("SELECT 1 FROM messages WHERE session_id=? AND seq<? LIMIT 1").get(sessionId, minSeq));
    db.exec("COMMIT");
    parentPort.postMessage({ id, value: { conversation: conversation.reverse(), total, hasMore, before, nextBefore: minSeq } });
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* BEGIN itself may have failed. */ }
    parentPort.postMessage({ id, error: { message: error.message, code: error.code || "MESSAGE_READ_FAILED" } });
  }
});
