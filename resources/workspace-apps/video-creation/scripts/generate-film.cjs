#!/usr/bin/env node
"use strict";

/**
 * Film producer: turn a director's storyboard.json into ONE finished film.
 *
 * The chat model is the DIRECTOR (judgment) — it writes the storyboard. This
 * script is the PRODUCER (deterministic): it generates each shot, the voice-over,
 * and stitches everything into a single mp4 with ffmpeg. No model calls here.
 *
 * Pipeline per storyboard:
 *   shot.keyframe ─(image skill)─► keyframe.png ─┐
 *                                                 ├─(video skill, first_frame)─► shot.mp4
 *   shot.prompt ──────────────────────────────────┘
 *   shot.narration ─(speech skill)─► shot.wav
 *   assembleFilm(): normalize + per-shot audio + subtitle + concat + BGM ─► film.mp4
 *
 * Reuses the sibling skill scripts as-is (same stdin-JSON contract), so all the
 * polling/download logic is shared. Script paths come from env (resolved by the
 * SKILL.md placeholders); ffmpeg from env FFMPEG_BIN, the bundle, or PATH.
 *
 * Input: storyboard JSON on stdin (schema in PROFESSIONAL-VIDEO-PLAN.md).
 * Output: <generated_media type="video"> with the final film path.
 *
 * Fail-loud: if ffmpeg is missing, or a shot fails, we DON'T emit a broken film —
 * we report the error and list whatever per-shot clips were produced, so the work
 * isn't lost (degrades to "separate clips", never to a corrupt deliverable).
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RES = {
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "1:1": { w: 1024, h: 1024 },
};
const FPS = 30;

function log(m) { process.stderr.write(`[lily-film] ${m}\n`); }
function fail(m, detail) {
  process.stderr.write(`[lily-film] ${m}${detail ? `\n  ${detail}` : ""}\n`);
  process.exit(1);
}

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function parseStoryboard(raw) {
  const sb = JSON.parse(String(raw || "{}"));
  if (!Array.isArray(sb.shots) || !sb.shots.length) {
    throw new Error("storyboard.shots must be a non-empty array");
  }
  const ratio = RES[sb.aspectRatio] ? sb.aspectRatio : "16:9";
  return {
    title: String(sb.title || "film"),
    aspectRatio: ratio,
    style: String(sb.style || ""),
    character: String(sb.character || ""),
    voice: sb.voice ? String(sb.voice) : "",
    musicUrl: sb.musicUrl ? String(sb.musicUrl) : "",
    subtitles: sb.subtitles !== false,
    shots: sb.shots.map((s, i) => ({
      id: s.id || i + 1,
      duration: Number(s.duration) || 5,
      keyframe: String(s.keyframe || "").trim(),
      prompt: String(s.prompt || "").trim(),
      narration: String(s.narration || "").trim(),
    })),
  };
}

// Resolve an installed generation skill's script. This producer lives in the app,
// the skills live at <userData>/lily-config/skills/<id>/scripts/. Order: explicit
// env override → installed skill dir (LILY_USER_DATA_DIR) → repo layout (dev). "".
function resolveScript(envPath, skillId, file) {
  if (envPath && fs.existsSync(envPath)) return envPath;
  const roots = [];
  if (process.env.LILY_USER_DATA_DIR) roots.push(path.join(process.env.LILY_USER_DATA_DIR, "lily-config", "skills"));
  // dev/repo fallbacks: bundled resources, or a sibling skills tree.
  roots.push(path.join(__dirname, "..", "..", "..", "skills"));
  roots.push(path.join(__dirname, "..", "..", "..", "..", "resources", "skills"));
  for (const root of roots) {
    const p = path.join(root, skillId, "scripts", file);
    if (fs.existsSync(p)) return p;
  }
  return "";
}

// ffmpeg, in priority order: explicit FFMPEG_BIN → app bundle
// (bundles/<plat>/ffmpeg/ffmpeg, beside the opencode engine) → PATH.
function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const keys = process.platform === "darwin"
    ? (process.arch === "arm64" ? ["darwin-arm64", "darwin-x64"] : ["darwin-x64", "darwin-arm64"])
    : process.platform === "win32" ? ["win32-x64"] : ["linux-x64"];
  const roots = [];
  if (process.env.LILY_BUNDLES_DIR) roots.push(process.env.LILY_BUNDLES_DIR);
  if (typeof process.resourcesPath === "string") roots.push(path.join(process.resourcesPath, "bundles"));
  for (const root of roots) {
    for (const key of keys) {
      const p = path.join(root, key, "ffmpeg", exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return "ffmpeg"; // PATH fallback (dev / system install)
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

function ffprobeDuration(ffmpegBin, file) {
  // ffprobe usually sits next to ffmpeg; fall back to "ffprobe" on PATH.
  const probe = ffmpegBin.endsWith("ffmpeg") ? ffmpegBin.replace(/ffmpeg$/, "ffprobe") : "ffprobe";
  const tryProbe = (bin) => run(bin, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  let r = fs.existsSync(probe) ? tryProbe(probe) : tryProbe("ffprobe");
  if (!r.ok) r = tryProbe("ffprobe");
  const d = parseFloat(String(r.stdout).trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function escDrawtext(text) {
  // ffmpeg drawtext escaping: backslash, colon, single quote, percent, newline.
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’")
    .replace(/%/g, "\\%")
    .replace(/\n/g, " ");
}

/**
 * Build ONE normalized segment per shot (uniform codec/res/fps so concat -c copy
 * is clean), with the shot's narration as its audio track (trimmed/padded to the
 * video length) and an optional burned-in subtitle. Returns the segment path.
 * Pure + deterministic given inputs — this is the unit-tested core.
 */
function buildSegment(ffmpegBin, { videoPath, audioPath, subtitle, fontFile, width, height, outPath }) {
  const dur = ffprobeDuration(ffmpegBin, videoPath) || 5;
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    `fps=${FPS}`,
    "format=yuv420p",
  ];
  if (subtitle && fontFile && fs.existsSync(fontFile)) {
    const fontPath = fontFile.replace(/\\/g, "/").replace(/:/g, "\\:");
    vf.push(
      `drawtext=fontfile='${fontPath}':text='${escDrawtext(subtitle)}':` +
        `fontcolor=white:fontsize=${Math.round(height / 22)}:box=1:boxcolor=black@0.5:boxborderw=10:` +
        "x=(w-text_w)/2:y=h-text_h-h*0.06",
    );
  }
  const args = ["-y", "-i", videoPath];
  if (audioPath) args.push("-i", audioPath);
  else args.push("-f", "lavfi", "-t", String(dur), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push(
    "-vf", vf.join(","),
    // Lock audio to the video duration: trim long narration, pad short with silence.
    "-af", `aresample=48000,apad,atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB`,
    "-map", "0:v:0", "-map", audioPath ? "1:a:0" : "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", dur.toFixed(3),
    outPath,
  );
  const r = run(ffmpegBin, args);
  if (!r.ok || !fs.existsSync(outPath)) {
    throw new Error(`segment build failed (${path.basename(videoPath)}): ${r.stderr.slice(-400) || r.error}`);
  }
  return outPath;
}

/**
 * Assemble normalized segments into the final film: concat, then optionally mix a
 * looped, ducked background-music bed under the voice-over. Returns final path.
 * Pure + deterministic — unit-tested with synthetic segments (no API needed).
 */
function assembleFilm(ffmpegBin, { segments, musicUrl, outPath, workDir }) {
  if (!segments.length) throw new Error("no segments to assemble");
  const listFile = path.join(workDir, "concat.txt");
  fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
  const concatPath = musicUrl ? path.join(workDir, "_concat.mp4") : outPath;
  let r = run(ffmpegBin, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatPath]);
  if (!r.ok || !fs.existsSync(concatPath)) {
    // Fall back to a re-encode concat if stream-copy refused (param mismatch).
    r = run(ffmpegBin, ["-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", concatPath]);
    if (!r.ok || !fs.existsSync(concatPath)) throw new Error(`concat failed: ${r.stderr.slice(-400)}`);
  }
  if (!musicUrl) return outPath;
  // Background music: loop to length, duck under the voice via sidechain compress.
  const total = ffprobeDuration(ffmpegBin, concatPath);
  const mix = run(ffmpegBin, ["-y", "-i", concatPath, "-stream_loop", "-1", "-i", musicUrl,
    "-filter_complex",
    `[1:a]volume=0.30,atrim=0:${total.toFixed(3)}[bg];` +
      "[0:a][bg]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300[duck];" +
      "[0:a][duck]amix=inputs=2:duration=first:weights=1 0.9[aout]",
    "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", outPath]);
  if (!mix.ok || !fs.existsSync(outPath)) {
    log("background-music mix failed; keeping voice-over-only cut");
    fs.copyFileSync(concatPath, outPath);
  }
  return outPath;
}

// --- orchestration (spawns the sibling generation skills) -------------------

function parseMediaPath(stdout) {
  const m = String(stdout).match(/<file\s+path="([^"]+)"/);
  return m ? m[1] : "";
}

function spawnSkill(scriptPath, input) {
  const node = process.env.NODE_BIN && fs.existsSync(process.env.NODE_BIN) ? process.env.NODE_BIN : process.execPath;
  const r = spawnSync(node, [scriptPath], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(scriptPath)} failed: ${(r.stderr || "").slice(-400)}`);
  const file = parseMediaPath(r.stdout);
  if (!file || !fs.existsSync(file)) throw new Error(`${path.basename(scriptPath)} produced no file`);
  return file;
}

// Content-addressed reuse so a re-run (or resume after a mid-film failure) NEVER
// re-pays for a clip/voice it already generated. Video is keyed by its visual
// content, audio by narration+voice — independent, so a failed audio never wastes
// a paid video, and identical narration is reused across shots.
const crypto = require("node:crypto");
function hashKey(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}
function cacheFileFor(outputDir, kind, key) {
  return path.join(outputDir, ".film-cache", `${kind}-${key}.json`);
}
function cachedAsset(outputDir, kind, key) {
  try {
    const rec = JSON.parse(fs.readFileSync(cacheFileFor(outputDir, kind, key), "utf8"));
    if (rec.path && fs.existsSync(rec.path)) return rec.path;
  } catch { /* miss */ }
  return "";
}
function putCachedAsset(outputDir, kind, key, assetPath) {
  try {
    const file = cacheFileFor(outputDir, kind, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ path: assetPath }));
  } catch { /* cache is best-effort */ }
}

function videoKey(sb, shot) {
  return hashKey({
    provider: process.env.LILY_VIDEO_PROVIDER || process.env.LILY_IMAGE_PROVIDER || "",
    style: sb.style, character: sb.character, ratio: sb.aspectRatio,
    prompt: shot.prompt, keyframe: shot.keyframe, duration: shot.duration,
  });
}
function audioKey(sb, shot) {
  return hashKey({ provider: "tts", voice: sb.voice, narration: shot.narration });
}

function produceShot(sb, shot, dims, outputDir, scripts) {
  const stylePrefix = sb.style ? `${sb.style}, ` : "";
  const charPrefix = sb.character ? `${sb.character}; ` : "";

  // ---- video (paid) — reuse if this exact shot was generated before ----
  let videoPath = cachedAsset(outputDir, "v", videoKey(sb, shot));
  if (videoPath) {
    log(`shot ${shot.id}: reusing cached clip (no charge)`);
  } else {
    let firstFrameUrl = "";
    if (shot.keyframe && scripts.image) {
      const kf = spawnSkill(scripts.image, {
        prompt: `${stylePrefix}${charPrefix}${shot.keyframe}`,
        size: `${dims.w}*${dims.h}`,
        output_dir: outputDir,
      });
      firstFrameUrl = `file://${kf}`;
    }
    const videoInput = {
      prompt: `${stylePrefix}${charPrefix}${shot.prompt}`,
      ratio: sb.aspectRatio,
      duration: shot.duration,
      output_dir: outputDir,
    };
    if (firstFrameUrl) videoInput.media = [{ type: "first_frame", url: firstFrameUrl }];
    videoPath = spawnSkill(scripts.video, videoInput);
    putCachedAsset(outputDir, "v", videoKey(sb, shot), videoPath); // bank it before audio can fail
  }

  // ---- audio (paid) — reuse by narration+voice ----
  let audioPath = "";
  if (shot.narration && scripts.speech) {
    audioPath = cachedAsset(outputDir, "a", audioKey(sb, shot));
    if (!audioPath) {
      audioPath = spawnSkill(scripts.speech, {
        text: shot.narration,
        ...(sb.voice ? { voice: sb.voice } : {}),
        format: "wav",
        output_dir: outputDir,
      });
      putCachedAsset(outputDir, "a", audioKey(sb, shot), audioPath);
    }
  }
  return { videoPath, audioPath, subtitle: sb.subtitles ? shot.narration : "" };
}

function main() {
  const ffmpegBin = resolveFfmpeg();
  if (!run(ffmpegBin, ["-version"]).ok) {
    fail("未找到 ffmpeg，无法合成成片。请确认已安装/打包 ffmpeg（设置 FFMPEG_BIN 或随包提供）。",
      "ffmpeg not found");
  }
  let sb;
  try { sb = parseStoryboard(readStdin()); }
  catch (e) { fail("storyboard 解析失败。", e.message); }

  const dims = RES[sb.aspectRatio];
  const outputDir = path.resolve(process.cwd(), process.env.FILM_OUTPUT_DIR || "generated-assets");
  fs.mkdirSync(outputDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(outputDir, ".film-"));
  const fontFile = process.env.SUBTITLE_FONT && fs.existsSync(process.env.SUBTITLE_FONT) ? process.env.SUBTITLE_FONT : "";
  const scripts = {
    image: resolveScript(process.env.LILY_IMAGE_SCRIPT, "lily-image-generation", "generate-image.cjs"),
    video: resolveScript(process.env.LILY_VIDEO_SCRIPT, "lily-video-generation", "generate-video.cjs"),
    speech: resolveScript(process.env.LILY_SPEECH_SCRIPT, "lily-speech-generation", "generate-speech.cjs"),
  };
  if (!scripts.video) {
    fail("找不到视频生成脚本 generate-video.cjs（同目录或 LILY_VIDEO_SCRIPT）。");
  }

  // Preflight: show the BILLABLE spend up front (cached shots cost nothing).
  const toGenerate = sb.shots.filter((s) => !cachedAsset(outputDir, "v", videoKey(sb, s))).length;
  log(`film: ${sb.shots.length} shots — ${sb.shots.length - toGenerate} reused (free), ${toGenerate} to generate (billable). Re-runs reuse cached shots; a failure resumes without re-paying.`);

  const segments = [];
  const madeClips = [];
  try {
    for (const shot of sb.shots) {
      const { videoPath, audioPath, subtitle } = produceShot(sb, shot, dims, outputDir, scripts);
      madeClips.push(videoPath);
      const seg = buildSegment(ffmpegBin, {
        videoPath, audioPath, subtitle, fontFile,
        width: dims.w, height: dims.h,
        outPath: path.join(workDir, `seg-${String(shot.id).padStart(3, "0")}.mp4`),
      });
      segments.push(seg);
    }
  } catch (e) {
    fail(`成片中断：${e.message}`,
      madeClips.length ? `已生成的分镜片段：\n  ${madeClips.join("\n  ")}` : "");
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(outputDir, `film-${ts}.mp4`);
  try {
    assembleFilm(ffmpegBin, { segments, musicUrl: sb.musicUrl, outPath: finalPath, workDir });
  } catch (e) {
    fail(`合成失败：${e.message}`, `已生成的分镜片段：\n  ${madeClips.join("\n  ")}`);
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }

  const bytes = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;
  process.stdout.write(`<generated_media type="video">\n  <file path="${finalPath}" bytes="${bytes}" />\n</generated_media>\n`);
}

if (require.main === module) main();

module.exports = {
  parseStoryboard, resolveFfmpeg, resolveScript, ffprobeDuration, buildSegment, assembleFilm,
  parseMediaPath, escDrawtext, videoKey, audioKey, cachedAsset, putCachedAsset,
};
