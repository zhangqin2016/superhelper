#!/usr/bin/env node
/**
 * Reading someone else's process honestly.
 *
 * Acceptance 2026-09-17 D-SUP-01: a managed job runs through the app binary in
 * Node mode, so Chromium's own logger writes 114 bytes into the child's stderr
 * before the job's code starts. Every job therefore had a non-empty stderr, and
 * "stderr is not empty" is the obvious way to judge one — a job that exited 0
 * looked failed.
 *
 * Acceptance 2026-09-17 D-S10-01: a worker silently ignored the size it was
 * given, processed zero items in three seconds, and exited 0. Every monitor
 * showed green, which from the user's side is indistinguishable from a long task
 * that stopped early.
 *
 * [gate: job-stderr-host-noise] [gate: job-work-evidence]
 * Run: node scripts/test-job-observation.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isHostDiagnosticLine,
  isHostNoiseOnlyFile,
  jobWorkEvidence,
  stripHostDiagnostics,
  withoutHostNoise,
} = require("../src/main/mcp/job-observation.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const NOISE = "[0917/080937.774442:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-job-observation-"));

try {
  check("the field case: the host's own line is recognised and removed, byte for byte", () => {
    assert.equal(isHostDiagnosticLine(NOISE), true);
    const stripped = stripHostDiagnostics(`${NOISE}\n`);
    assert.equal(stripped.text.trim(), "");
    assert.equal(stripped.removedLines, 1);
    assert.equal(stripped.removedBytes, 114, "exactly the 114 bytes the acceptance measured");
    assert.equal(stripped.hostNoiseOnly, true);
  });

  check("a job's own output is never touched, and a real error still comes through", () => {
    assert.equal(isHostDiagnosticLine("Traceback (most recent call last):"), false);
    assert.equal(isHostDiagnosticLine("[INFO] my own bracketed log line"), false);
    assert.equal(isHostDiagnosticLine("[0917/080937] not the host format"), false);
    const mixed = stripHostDiagnostics(`${NOISE}\nTraceback (most recent call last):\n  boom\n`);
    assert.match(mixed.text, /Traceback/);
    assert.match(mixed.text, /boom/);
    assert.equal(mixed.hostNoiseOnly, false, "a job that really failed is still visibly failing");
    const clean = "no host noise here\n";
    assert.equal(stripHostDiagnostics(clean).text, clean, "a clean log is returned unchanged");
    assert.equal(stripHostDiagnostics("").removedLines, 0);
  });

  check("a log range carries what was removed, so nothing is hidden", () => {
    const range = { text: `${NOISE}\n`, byteSize: 114, nextOffset: 114 };
    const filtered = withoutHostNoise(range);
    assert.equal(filtered.hostNoiseLines, 1);
    assert.equal(filtered.hostNoiseBytes, 114);
    assert.equal(filtered.hostNoiseOnly, true);
    assert.equal(filtered.byteSize, 114, "the file's real size is still reported");
    const untouched = { text: "real output", byteSize: 11 };
    assert.equal(withoutHostNoise(untouched), untouched, "no noise means the exact same object");
  });

  check("a stderr file that is nothing but host noise is reported as such", () => {
    const readRange = (file) => ({ text: fs.readFileSync(file, "utf8") });
    const fileSize = (file) => fs.statSync(file).size;
    const noiseOnly = path.join(tmp, "noise.log");
    fs.writeFileSync(noiseOnly, `${NOISE}\n`);
    assert.equal(isHostNoiseOnlyFile(noiseOnly, { readRange, fileSize }), true);

    const realError = path.join(tmp, "real.log");
    fs.writeFileSync(realError, `${NOISE}\nTraceback\n`);
    assert.equal(isHostNoiseOnlyFile(realError, { readRange, fileSize }), false);

    const empty = path.join(tmp, "empty.log");
    fs.writeFileSync(empty, "");
    assert.equal(isHostNoiseOnlyFile(empty, { readRange, fileSize }), false, "empty is not noise");
    assert.equal(isHostNoiseOnlyFile("", { readRange, fileSize }), false);
    assert.equal(isHostNoiseOnlyFile(noiseOnly, {}), false, "no reader means no claim");
    assert.equal(isHostNoiseOnlyFile(noiseOnly, { readRange: () => { throw new Error("x"); }, fileSize }), false);
  });

  check("work evidence is a fact, and zero processed is not work", () => {
    assert.deepEqual(jobWorkEvidence({}), { workObserved: false, workEvidence: [] });
    assert.deepEqual(jobWorkEvidence({ progress: { current: 30000, total: 30000 } }),
      { workObserved: true, workEvidence: ["progress_count"] });
    // The D-S10-01 shape: it reported progress, and the progress was nothing.
    assert.equal(jobWorkEvidence({ progress: { current: 0, total: 30000 } }).workObserved, false);
    assert.deepEqual(jobWorkEvidence({ progress: { current: 0, total: 30000 } }).workEvidence,
      ["progress_reported_without_count"]);
    assert.equal(jobWorkEvidence({ progress: { phase: "分片计算" } }).workObserved, false,
      "a phase name says the worker is alive, not that anything was processed");
    assert.equal(jobWorkEvidence({ progress: { percent: 42 } }).workObserved, true);
    assert.equal(jobWorkEvidence({ progress: { percent: 0 } }).workObserved, false);
    assert.equal(jobWorkEvidence({ outputFiles: ["/out/a.pdf"] }).workObserved, true);
    assert.equal(jobWorkEvidence({ outputFiles: [] }).workObserved, false);
  });

  check("the job status surfaces both facts", () => {
    const source = fs.readFileSync(new URL("../src/main/mcp/process-jobs-core.js", import.meta.url), "utf8");
    assert.match(source, /stderrHostNoiseOnly: isHostNoiseOnlyFile/);
    assert.match(source, /\.\.\.jobWorkEvidence\(\{ progress, outputFiles/);
    assert.match(source, /stderr: withoutHostNoise\(readRange/);
  });

  console.log(`\n${checks} checks passed (job observation)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
