// OpenCode port of Lily's PostToolUse verification hook (resources/hooks/verify-edit.cjs),
// at full parity. After an edit/write/bash tool runs, do fast deterministic checks
// and append a [verify] note to the tool output so the model self-corrects.
// FAIL OPEN: anything we can't check confidently is left alone (never block, never
// false-positive). Runs inside the OpenCode (Bun) server process.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const CHECK_TIMEOUT_MS = 10_000;
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim().split(/\r?\n/)[0] : "";
}
function runCheck(bin, args) {
  if (!bin) return null;
  const r = spawnSync(bin, args, { timeout: CHECK_TIMEOUT_MS, encoding: "utf8" });
  if (r.error || r.signal) return null; // unavailable/slow -> fail open
  return r.status === 0 ? "" : (r.stderr || r.stdout || "check failed");
}

// --- syntax checks ----------------------------------------------------------
function checkSyntax(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) {
    try { JSON.parse(fs.readFileSync(file, "utf8")); return ""; }
    catch (e) { return `Invalid JSON in ${file}: ${e.message}`; }
  }
  if (/\.(c|m)?jsx?$|\.(c|m)?tsx?$/.test(lower)) {
    const err = runCheck(which("node"), ["--check", file]);
    return err ? `Syntax error in ${file}:\n${err}` : "";
  }
  if (lower.endsWith(".py")) {
    const err = runCheck(which("python3") || which("python"), ["-m", "py_compile", file]);
    return err ? `Python syntax error in ${file}:\n${err}` : "";
  }
  return "";
}

// --- file-format structure (magic bytes) ------------------------------------
const B = (s) => Buffer.from(s, "binary");
const MAGIC = {
  zip: [B("PK\x03\x04"), B("PK\x05\x06")],
  pdf: [B("%PDF")],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  gif: [B("GIF8")],
  webp: [B("RIFF")],
  mp3: [B("ID3"), Buffer.from([0xff, 0xfb]), Buffer.from([0xff, 0xf3])],
  wav: [B("RIFF")],
  ogg: [B("OggS")],
  webm: [Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
};
const EXT_MAGIC = {
  ".docx": MAGIC.zip, ".xlsx": MAGIC.zip, ".pptx": MAGIC.zip, ".zip": MAGIC.zip,
  ".pdf": MAGIC.pdf, ".png": MAGIC.png, ".jpg": MAGIC.jpg, ".jpeg": MAGIC.jpg,
  ".gif": MAGIC.gif, ".webp": MAGIC.webp,
};
const MEDIA_MAGIC = {
  image: [...MAGIC.png, ...MAGIC.jpg, ...MAGIC.gif, ...MAGIC.webp],
  audio: [...MAGIC.mp3, ...MAGIC.wav, ...MAGIC.ogg],
  video: [...MAGIC.webm, ...MAGIC.wav],
};
function readHead(file, bytes = 16) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, read);
  } catch { return null; }
}
const matchesAny = (head, magics) => magics.some((m) => head.length >= m.length && head.subarray(0, m.length).equals(m));
const isVideoHead = (head) => matchesAny(head, MEDIA_MAGIC.video) || (head.length >= 8 && head.subarray(4, 8).toString("binary") === "ftyp");

function checkStructure(file) {
  const ext = (file.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  const magics = EXT_MAGIC[ext];
  if (!magics) return "";
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return ""; }
  if (size === 0) return `Generated file is empty: ${file}`;
  const head = readHead(file);
  if (!head) return "";
  return matchesAny(head, magics) ? "" : `File ${file} does not look like a valid ${ext} (wrong header). Regenerate it properly.`;
}

// --- generated_media declarations (in bash/tool output) ---------------------
function checkGeneratedMedia(outputText) {
  const issues = [];
  for (const [block, type] of String(outputText || "").matchAll(/<generated_media\s+type="([^"]*)"[\s\S]*?<\/generated_media>/g)) {
    for (const m of block.matchAll(/<file\s+path="([^"]+)"/g)) {
      const file = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      if (!fs.existsSync(file)) { issues.push(`generated_media declares ${file} but it does not exist.`); continue; }
      let size = 0; try { size = fs.statSync(file).size; } catch { continue; }
      if (size === 0) { issues.push(`generated_media file is empty: ${file}.`); continue; }
      const head = readHead(file); if (!head) continue;
      if (type === "image" && !matchesAny(head, MEDIA_MAGIC.image)) issues.push(`${file} declared image but is not a valid image.`);
      if (type === "audio" && !matchesAny(head, MEDIA_MAGIC.audio)) issues.push(`${file} declared audio but is not valid audio.`);
      if (type === "video" && !isVideoHead(head)) issues.push(`${file} declared video but is not valid video.`);
    }
  }
  return issues.join("\n");
}

function targetFile(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["filePath", "path", "file", "filename"]) {
    if (typeof args[key] === "string" && args[key]) return args[key];
  }
  return "";
}

export const VerifyEditPlugin = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      const tool = String(input?.tool || "").toLowerCase();
      const notes = [];
      if (EDIT_TOOLS.has(tool)) {
        const file = targetFile(input?.args);
        if (file && fs.existsSync(file)) {
          notes.push(checkSyntax(file), checkStructure(file));
        }
      }
      if (tool === "bash") {
        notes.push(checkGeneratedMedia(output?.output));
      }
      const issue = notes.filter(Boolean).join("\n");
      if (issue) {
        output.output = `${output.output || ""}\n\n[verify] ${issue}\nFix this before continuing.`;
      }
    } catch {
      /* fail open — verification must never break a turn */
    }
  },
});

export default VerifyEditPlugin;
