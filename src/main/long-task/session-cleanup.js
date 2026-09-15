"use strict";

/**
 * Stop a session's durable process jobs when the conversation is deleted.
 *
 * Before 2026-09-14 deleting a conversation left its detached workers running
 * to completion; their wake then resolved SESSION_NOT_FOUND and was dropped
 * silently. Deletion is a task boundary: active jobs get SIGTERM, then SIGKILL
 * after a short grace, and are marked `cancelled` with the reason recorded.
 * Fail-open: any error stops nothing extra and is reported, never thrown.
 */

const { LongTaskStore } = require("./store");
const { stopPidTree } = require("../process-tree-kill");

const HOLDER = "lily-session-cleanup";
const ACTIVE = ["starting", "running", "stopping"];

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function waitExit(pid, ms, sleep) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  return !alive(pid);
}

/**
 * @param {{ dbPath: string, ownerScope: string, sessionId: string, projectId: string,
 *   graceMs?: number, sleep?: (ms:number)=>Promise<void>, now?: () => number }} input
 * @returns {Promise<{ ok:boolean, stopped:string[], failed:Array<{jobId:string, error:string}>, total:number }>}
 */
async function stopJobsForSession(input = {}) {
  const sleep = input.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const result = { ok: true, stopped: [], failed: [], total: 0 };
  if (!input.dbPath || !input.ownerScope || !input.sessionId) return result;
  let store = null;
  try {
    store = new LongTaskStore({ filePath: input.dbPath, now: input.now || Date.now });
    // Scopes are (owner, session, project, turn); a deletion spans every turn
    // of the session, so select by owner+session and rebuild each job's scope.
    const rows = store.db.all(
      `SELECT id, owner_scope, session_id, project_id, turn_id FROM long_task_jobs
       WHERE owner_scope=? AND session_id=? AND status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY created_at LIMIT 200`,
      input.ownerScope, input.sessionId, ...ACTIVE,
    );
    result.total = rows.length;
    for (const row of rows) {
      const scope = { ownerScope: row.owner_scope, sessionId: row.session_id, projectId: row.project_id, turnId: row.turn_id };
      const job = store.getJob(scope, row.id);
      if (!job) continue;
      try {
        const claim = store.claimLease(scope, job.id, { holder: HOLDER, ttlMs: 60_000, forceTakeover: true });
        if (!claim.ok) { result.failed.push({ jobId: job.id, error: claim.error || "LEASE_FAILED" }); continue; }
        if (job.pid) {
          stopPidTree(job.pid, "SIGTERM");
          if (!(await waitExit(job.pid, Math.max(200, Number(input.graceMs) || 3_000), sleep))) stopPidTree(job.pid, "SIGKILL");
        }
        const terminal = store.markTerminal(scope, job.id, {
          holder: HOLDER, fencingEpoch: claim.job.fencingEpoch, status: "cancelled", signal: "SIGTERM", error: "SESSION_DELETED",
        });
        if (terminal.ok || terminal.error === "TERMINAL_IMMUTABLE") result.stopped.push(job.id);
        else result.failed.push({ jobId: job.id, error: terminal.error || "TERMINAL_FAILED" });
      } catch (error) {
        result.failed.push({ jobId: job.id, error: error?.message || "STOP_FAILED" });
      }
    }
  } catch (error) {
    result.ok = false;
    result.error = error?.message || "SESSION_CLEANUP_FAILED";
  } finally {
    try { store?.close?.(); } catch { /* best effort */ }
  }
  return result;
}

module.exports = { stopJobsForSession, HOLDER };
