#!/usr/bin/env node
// Verifies the 视频创作 workspace-app package builds, passes server inspection, and
// carries the right skills + setup script. WHY: this is the app-store artifact — if
// it doesn't declare the media skills or ship the ffmpeg setup, an installed app
// can't actually produce a film (degrades to "no video"), the opposite of the goal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { assert } from "./lib/test-assert.mjs";
import { inspectWorkspaceAppArtifact } from "../server/src/services/workspace-apps.js";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-video-app-"));

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build-video-creation-workspace-app.mjs"),
      "--out", tmpDir,
      "--version", "test-video-app",
      "--exported-at", "2026-06-28T00:00:00.000Z",
    ],
    { cwd: root, stdio: "pipe" },
  );

  const artifact = path.join(tmpDir, "video-creation-test-video-app.lilyspace.zip");
  assert(fs.existsSync(artifact), "video creation app package is built");

  const buffer = fs.readFileSync(artifact);
  const inspected = await inspectWorkspaceAppArtifact(buffer);
  assert(inspected.ok, `workspace app artifact passes server inspection: ${inspected.code || ""}`);
  assert(inspected.manifest.kind === "lily-workspace-app", "manifest uses workspace app kind");
  for (const skill of ["lily-video-generation", "lily-image-generation", "lily-speech-generation"]) {
    assert(inspected.manifest.requiredSkills?.includes(skill), `manifest requires ${skill}`);
  }

  const zip = await JSZip.loadAsync(buffer);
  const rawManifest = JSON.parse(await zip.file("lily-workspace.json").async("string"));
  const readme = await zip.file("files/README.md").async("string");
  const agentsMd = await zip.file("files/AGENTS.md").async("string");
  const setup = await zip.file("files/scripts/setup-ffmpeg.cjs").async("string");
  const filmEntry = zip.file("files/scripts/generate-film.cjs");
  assert(!!filmEntry, "the heavy film producer ships INSIDE the app (not the skill)");
  const film = await filmEntry.async("string");

  assert(rawManifest.appId === "video-creation", "raw manifest has stable app id");
  assert(rawManifest.folderName === "video-creation", "raw manifest has stable English folder name");
  assert(rawManifest.name === "视频创作", "app name is 视频创作");
  assert(readme.includes("ffmpeg") && readme.includes("不进主安装包"), "README states ffmpeg is fetched, not bundled in installer");
  assert(agentsMd.includes("files/scripts/generate-film.cjs"), "AGENTS invokes the app-bundled producer");
  assert(agentsMd.includes("storyboard"), "AGENTS teaches the storyboard/director step");
  assert(/FFMPEG_BIN/.test(agentsMd), "AGENTS wires FFMPEG_BIN into the producer");
  // the producer must self-resolve installed skills (it lives in the app, not the skill dir)
  assert(/LILY_USER_DATA_DIR/.test(film), "producer resolves installed skills via LILY_USER_DATA_DIR");
  const tmpFilm = path.join(tmpDir, "generate-film.cjs");
  fs.writeFileSync(tmpFilm, film);
  execFileSync(process.execPath, ["--check", tmpFilm], { stdio: "pipe" });
  // setup script must resolve ffmpeg safely (PATH first, download only if a source is set)
  assert(setup.includes('works("ffmpeg")'), "setup falls back to a system ffmpeg on PATH");
  assert(setup.includes("LILY_FFMPEG_URL"), "setup download source is configurable (CDN)");
  assert(/process\.exit\(1\)/.test(setup), "setup fails loud when no ffmpeg and no source");
  // The script must be valid JS.
  const tmpJs = path.join(tmpDir, "setup-ffmpeg.cjs");
  fs.writeFileSync(tmpJs, setup);
  execFileSync(process.execPath, ["--check", tmpJs], { stdio: "pipe" });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("video-creation-workspace-app-package: ok");
