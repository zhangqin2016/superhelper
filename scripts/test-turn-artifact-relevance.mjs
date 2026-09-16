#!/usr/bin/env node
// Deliverable relevance: a turn's artifact list is what the user asked for, not
// every file the turn created on the way there. Lily's own scratch directory
// (.lily-work) and the OS temp dir are working material; a real export to an
// absolute path the user chose is not. A turn that produced ONLY working
// material still shows it (compact), so the list is never emptied.
// Field case 2026-09-16: one turn listed 18 intermediate .lily-work webm clips
// and four /tmp html scratch files beside the two real files in output/.
// [gate: deliverable-relevance]
// Run: node scripts/test-turn-artifact-relevance.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTurnArtifacts, isProcessArtifactPath } = require("../src/main/turn-artifacts.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-artifact-relevance-"));
const write = (relative, body = "x") => {
  const full = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

try {
  // The screenshot, reconstructed: a video turn renders its shots into the
  // scratch dir, drops scratch html in /tmp, and delivers into output/.
  const shots = ["shot-01.webm", "shot-02.webm", "shot-03.webm"]
    .map((name) => write(path.join(".lily-work", "public-video", "shots", name)));
  const plan = write(path.join("output", "public-operation-video-plan.md"), "# 方案\n");
  const demo = write(path.join("output", "public-demo.mp4"), "fake mp4");
  const tmpScratch = path.join(os.tmpdir(), `lily-relevance-scratch-${process.pid}.html`);
  fs.writeFileSync(tmpScratch, "<html></html>");

  check("scratch clips and temp files drop out while the real deliverables stay", () => {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      tools: [{
        name: "bash",
        status: "done",
        input: { command: `ffmpeg -i in.mp4 ${shots.join(" ")} && cp x ${tmpScratch}` },
        result: [...shots, tmpScratch, plan, demo].join("\n"),
      }],
    });
    const listed = artifacts.map((artifact) => artifact.relativePath).sort();
    assert.deepEqual(listed, ["output/public-demo.mp4", "output/public-operation-video-plan.md"]);
    assert.ok(artifacts.every((artifact) => !artifact.display), "deliverables keep their normal presentation");
  });

  check("a turn whose ONLY product is working material still shows it, marked compact", () => {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      tools: [{ name: "bash", status: "done", input: { command: "ffmpeg" }, result: shots.join("\n") }],
    });
    assert.equal(artifacts.length, shots.length, "the list is never emptied");
    assert.ok(artifacts.every((artifact) => artifact.display === "compact"));
  });

  check("an explicit write into the scratch dir is working material too, not a deliverable", () => {
    const note = write(path.join(".lily-work", "notes.md"), "# scratch\n");
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      fileChanges: [{ filePath: note }, { filePath: plan }],
    });
    assert.deepEqual(artifacts.map((artifact) => artifact.relativePath), ["output/public-operation-video-plan.md"]);
  });

  check("classification: scratch segments and temp roots only; a chosen export path survives", () => {
    const root = "/Users/someone/work";
    assert.equal(isProcessArtifactPath(`${root}/output/report.pdf`, root), false);
    assert.equal(isProcessArtifactPath(`${root}/.lily-work/public-video/shots/a.webm`, root), true);
    assert.equal(isProcessArtifactPath(`${root}/node_modules/pkg/logo.png`, root), true);
    assert.equal(isProcessArtifactPath(`${root}/dist/app.html`, root), false, "a build output is a real delivery");
    assert.equal(isProcessArtifactPath("/tmp/up3.html", root), true);
    assert.equal(isProcessArtifactPath("/private/var/folders/ab/T/x.html", root), true);
    assert.equal(isProcessArtifactPath("/Users/someone/Desktop/report.pdf", root), false, "the user asked for this path");
    // A workspace that itself lives under the temp dir (every test harness) is
    // a workspace, not scratch — the inside-workspace rule decides first.
    assert.equal(isProcessArtifactPath(path.join(workspace, "output", "a.mp4"), workspace), false);
  });

  fs.rmSync(tmpScratch, { force: true });
  console.log(`\n${checks} checks passed (turn artifact relevance)`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
