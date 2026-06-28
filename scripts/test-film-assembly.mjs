#!/usr/bin/env node
/**
 * Proves the film PRODUCER's assembly engine actually outputs one finished film —
 * the core of "可以直接出片". Uses ffmpeg-synthesized clips/audio (no paid API), so
 * it verifies the deterministic half end-to-end: per-shot normalize + voice-over
 * sync (trim long / pad short) + concat into a single playable mp4.
 *
 * WHY this matters: the value claim is "文案 → 成片". The model half (storyboard,
 * shot generation) is judgment we can't unit-test cheaply, but the assembly half
 * is pure code and MUST be provably correct, or every film is broken.
 *
 * Skips (exit 0) if ffmpeg is unavailable — assembly is impossible without it and
 * that path already fails loud at runtime.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const film = require("../resources/workspace-apps/video-creation/scripts/generate-film.cjs");

const ffmpeg = film.resolveFfmpeg();
if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
  console.log("test-film-assembly: SKIP (no ffmpeg)");
  process.exit(0);
}

// --- pure-unit checks ------------------------------------------------------
assert.equal(film.parseMediaPath('<file path="/a/b/c.mp4" bytes="1" />'), "/a/b/c.mp4");
assert.throws(() => film.parseStoryboard('{"shots":[]}'), /non-empty/, "empty storyboard must reject");
const sb = film.parseStoryboard(JSON.stringify({
  aspectRatio: "21:9", // invalid → falls back to 16:9
  shots: [{ prompt: "a", duration: 2 }],
}));
assert.equal(sb.aspectRatio, "16:9", "unknown ratio falls back to 16:9");
assert.equal(film.escDrawtext("a:b'c").includes("\\:"), true, "drawtext colon escaped");
// the producer must self-resolve the sibling generation scripts (no env needed)
assert.ok(film.resolveScript("", "lily-video-generation", "generate-video.cjs").endsWith("generate-video.cjs"),
  "video script resolves from the same dir");
assert.equal(film.resolveScript("", "no-such-skill", "nope.cjs"), "", "missing script resolves to empty");

// --- cost guard: per-shot cache reuse (never re-pay for the same shot) ------
{
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "film-cache-"));
  const sbX = { style: "s", character: "c", aspectRatio: "16:9", voice: "v" };
  const shotX = { id: 1, prompt: "p", keyframe: "", duration: 5, narration: "n" };
  const vk = film.videoKey(sbX, shotX);
  assert.equal(film.cachedAsset(cdir, "v", vk), "", "cold cache is a miss");
  const clip = path.join(cdir, "clip.mp4"); fs.writeFileSync(clip, "x");
  film.putCachedAsset(cdir, "v", vk, clip);
  assert.equal(film.cachedAsset(cdir, "v", vk), clip, "cached shot is reused (no re-charge)");
  // a changed prompt → different key → not a false reuse
  assert.equal(film.cachedAsset(cdir, "v", film.videoKey(sbX, { ...shotX, prompt: "different" })), "", "changed shot is regenerated, not falsely reused");
  // audio cached independently of video
  assert.notEqual(film.audioKey(sbX, shotX), vk, "audio and video use separate keys");
  fs.rmSync(cdir, { recursive: true, force: true });
}

// --- assembly engine e2e (synthetic clips + voice-over) --------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "film-test-"));
const W = 1280, H = 720;

function mkClip(out, color, dur) {
  const r = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i",
    `testsrc=size=640x360:rate=24:duration=${dur},format=yuv420p`,
    "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=${dur}`, // unused, just exercises 2 inputs
    "-map", "0:v", "-t", String(dur), out], { encoding: "utf8" });
  assert.ok(fs.existsSync(out), "synthetic clip created: " + (r.stderr || "").slice(-200));
}
function mkAudio(out, dur) {
  spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i",
    `sine=frequency=440:duration=${dur}`, "-c:a", "pcm_s16le", out]);
  assert.ok(fs.existsSync(out), "synthetic audio created");
}

const clip1 = path.join(dir, "v1.mp4"); mkClip(clip1, "red", 2);
const clip2 = path.join(dir, "v2.mp4"); mkClip(clip2, "blue", 3);
// narration shorter than shot 1 (must pad) and longer than shot 2 (must trim)
const aud1 = path.join(dir, "a1.wav"); mkAudio(aud1, 0.5);
const aud2 = path.join(dir, "a2.wav"); mkAudio(aud2, 9);

const seg1 = film.buildSegment(ffmpeg, { videoPath: clip1, audioPath: aud1, subtitle: "", fontFile: "", width: W, height: H, outPath: path.join(dir, "s1.mp4") });
const seg2 = film.buildSegment(ffmpeg, { videoPath: clip2, audioPath: aud2, subtitle: "", fontFile: "", width: W, height: H, outPath: path.join(dir, "s2.mp4") });

// each segment's audio must equal its VIDEO length (sync), not the narration length
const d1 = film.ffprobeDuration(ffmpeg, seg1);
const d2 = film.ffprobeDuration(ffmpeg, seg2);
assert.ok(Math.abs(d1 - 2) < 0.4, `seg1 ~2s, got ${d1}`);
assert.ok(Math.abs(d2 - 3) < 0.4, `seg2 ~3s, got ${d2}`);

const out = path.join(dir, "film.mp4");
film.assembleFilm(ffmpeg, { segments: [seg1, seg2], musicUrl: "", outPath: out, workDir: dir });
assert.ok(fs.existsSync(out), "final film produced");
const total = film.ffprobeDuration(ffmpeg, out);
assert.ok(Math.abs(total - 5) < 0.6, `film ~5s (2+3), got ${total}`);

// final must have both a video and an audio stream + correct resolution
const probe = spawnSync(ffmpeg.replace(/ffmpeg$/, "ffprobe").includes("ffprobe") ? ffmpeg.replace(/ffmpeg$/, "ffprobe") : "ffprobe",
  ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", out], { encoding: "utf8" });
const info = probe.stdout || "";
assert.ok(/video/.test(info), "final has a video stream");
assert.ok(/audio/.test(info), "final has an audio stream (voice-over track)");
assert.ok(info.includes(`${W},${H}`), `final normalized to ${W}x${H}: ${info.replace(/\n/g, " ")}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log("test-film-assembly: ok");
