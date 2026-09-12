"use strict";

const fs = require("node:fs");
const { latestWorkProgress } = require("../work-progress-protocol");

// Observation runs in the main process too. Never read an unbounded batch log.
function progressTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(size - start);
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, length).toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return ""; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Both observers use this before terminal admission. A rejected progress write
// must not be followed by a terminal write based on the stale observation.
function recordJobProgress(store, scope, job, holder) {
  const progress = latestWorkProgress(`${progressTail(job.stdoutPath)}\n${progressTail(job.stderrPath)}`);
  if (!progress || JSON.stringify(progress) === JSON.stringify(job.progress)) return { ok: true, job };
  return store.recordProgress(scope, job.id, {
    holder, fencingEpoch: job.fencingEpoch, progressSeq: job.progressSeq + 1, progress,
  });
}

module.exports = { recordJobProgress };
