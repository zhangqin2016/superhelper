"use strict";

/**
 * What can honestly be said about a job whose code we did not write.
 *
 * Two questions, both about not misreading someone else's process.
 *
 * 1. Diagnostics the HOST writes into a job's stderr, which the job never
 *    produced.
 *
 * A managed job runs through the app binary in Node mode, so Chromium/Electron's
 * own logger writes into the child's stderr before the job's code starts. On
 * macOS every single job therefore carries
 *   [0917/080937.774442:ERROR:electron/shell/common/mac/codesign_util.cc:79]
 *   task_name_for_pid: (os/kern) failure (5)
 * Acceptance 2026-09-17 D-SUP-01: a job that exited 0 looked failed, because
 * "stderr is not empty" is the obvious way to judge one.
 *
 * The log FILE is never rewritten — it is the honest record. What changes is that
 * host noise is not handed back as if the job had said it, and a stderr that is
 * nothing but host noise is reported as such.
 *
 * Narrow on purpose: only the host logger's own line format matches. A job that
 * happens to print something similar keeps its output.
 *
 * 2. Whether the job did anything at all. "Exit code 0" answers a different
 *    question: acceptance 2026-09-17 D-S10-01 is the shape to worry about — a
 *    worker silently ignored the size it was given, finished in three seconds
 *    having processed zero items, and exited 0, so every monitor showed green.
 *    From the user's side that is indistinguishable from a long task that
 *    stopped early. This reports a FACT, never a verdict: a fast job that
 *    legitimately had nothing to do is a real case, so nothing here calls a
 *    success a failure.
 *
 * [gate: job-stderr-host-noise] [gate: job-work-evidence]
 */

// Chromium's logging prefix: [MMDD/HHMMSS.micros:LEVEL:file.cc(:line)?]
const HOST_DIAGNOSTIC_RE = /^\[\d{4}\/\d{6}\.\d+:(?:ERROR|WARNING|INFO|VERBOSE\d*|FATAL):[^\]]+\]/;

function isHostDiagnosticLine(line) {
  return HOST_DIAGNOSTIC_RE.test(String(line || "").trimStart());
}

/**
 * @returns {{ text: string, removedLines: number, removedBytes: number, hostNoiseOnly: boolean }}
 */
function stripHostDiagnostics(text) {
  const original = String(text ?? "");
  if (!original) return { text: original, removedLines: 0, removedBytes: 0, hostNoiseOnly: false };
  const lines = original.split("\n");
  const kept = [];
  let removedLines = 0;
  for (const line of lines) {
    if (isHostDiagnosticLine(line)) {
      removedLines += 1;
      continue;
    }
    kept.push(line);
  }
  if (!removedLines) return { text: original, removedLines: 0, removedBytes: 0, hostNoiseOnly: false };
  const next = kept.join("\n");
  return {
    text: next,
    removedLines,
    removedBytes: Buffer.byteLength(original, "utf8") - Buffer.byteLength(next, "utf8"),
    // Nothing but host noise: the job itself wrote nothing to stderr.
    hostNoiseOnly: next.trim() === "",
  };
}

/**
 * A readRange() result with host noise removed from its text, annotated with what
 * was removed. Returns the range unchanged when there was no noise.
 */
function withoutHostNoise(range = {}) {
  const stripped = stripHostDiagnostics(range.text);
  if (!stripped.removedLines) return range;
  return {
    ...range,
    text: stripped.text,
    hostNoiseLines: stripped.removedLines,
    hostNoiseBytes: stripped.removedBytes,
    hostNoiseOnly: stripped.hostNoiseOnly,
  };
}

/**
 * True when a job's stderr file contains nothing but host diagnostics — so a
 * non-zero stderr size is not evidence that anything went wrong.
 */
function isHostNoiseOnlyFile(filePath, { readRange, fileSize, tailBytes } = {}) {
  if (!filePath || typeof readRange !== "function") return false;
  try {
    if (typeof fileSize === "function" && !fileSize(filePath)) return false;
    return stripHostDiagnostics(readRange(filePath, { tailBytes }).text).hostNoiseOnly;
  } catch {
    return false;
  }
}

function positiveCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

/**
 * @param {{ progress?: object|null, outputFiles?: string[] }} observation
 * @returns {{ workObserved: boolean, workEvidence: string[] }}
 */
function jobWorkEvidence({ progress = null, outputFiles = [] } = {}) {
  const evidence = [];
  let observed = false;
  if (progress && typeof progress === "object") {
    const count = progress.current ?? progress.done ?? progress.processed ?? progress.pageIndex;
    const percent = progress.percent ?? progress.value;
    if (positiveCount(count)) { evidence.push("progress_count"); observed = true; }
    else if (positiveCount(percent)) { evidence.push("progress_percent"); observed = true; }
    // A progress line that reports zero, or only a phase name, means the worker
    // is alive — it does NOT mean anything was processed.
    else evidence.push("progress_reported_without_count");
  }
  if (Array.isArray(outputFiles) && outputFiles.length) { evidence.push("output_files"); observed = true; }
  return { workObserved: observed, workEvidence: evidence };
}

module.exports = {
  HOST_DIAGNOSTIC_RE,
  isHostDiagnosticLine,
  isHostNoiseOnlyFile,
  jobWorkEvidence,
  stripHostDiagnostics,
  withoutHostNoise,
};
