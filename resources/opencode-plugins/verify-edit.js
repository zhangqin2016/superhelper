// OpenCode port of Lily's PostToolUse verification hook (resources/hooks/verify-edit.cjs),
// at full parity. After an edit/write/bash tool runs, do fast deterministic checks
// and append a [verify] note to the tool output so the model self-corrects.
// FAIL OPEN: anything we can't check confidently is left alone (never block, never
// false-positive). Runs inside the OpenCode (Bun) server process.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHECK_TIMEOUT_MS = 10_000;
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
// Per-edit lint adds latency; let latency-sensitive users opt out.
const LINT_DISABLED = process.env.LILY_SKIP_LINT_VERIFY === "1";

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

// node_modules/.bin shims are .cmd batch files on Windows; spawnSync can't exec
// them directly (EINVAL) — they must go through the shell. Quote bin + args so a
// project path containing spaces survives cmd.exe word-splitting.
function spawnLocalBin(bin, args, opts) {
  if (process.platform === "win32") {
    return spawnSync(`"${bin}"`, args.map((a) => `"${a}"`), { ...opts, shell: true, windowsHide: true });
  }
  return spawnSync(bin, args, opts);
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

// --- semantic lint (errors only, project's OWN linter, fail open) -----------
// Walk up from the edited file to find a project-local linter binary so we only
// run a linter the project already uses (never impose a global one).
function findLocalBin(name, fromFile) {
  let dir = path.dirname(path.resolve(fromFile));
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, "node_modules", ".bin", name);
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

// Catch real defects (undefined vars, bad imports, unused) the SAME turn, beyond
// pure syntax. Errors only (no style noise). Toolchain-gated: nothing runs unless
// the project ships the linter, and any non-lint failure (e.g. eslint exit 2 =
// no config) is treated as "can't check" → fail open.
function checkLint(file) {
  if (LINT_DISABLED) return "";
  const lower = file.toLowerCase();
  if (/\.(c|m)?[jt]sx?$/.test(lower)) {
    const bin = findLocalBin(process.platform === "win32" ? "eslint.cmd" : "eslint", file);
    if (!bin) return ""; // project doesn't use eslint → don't impose it
    const r = spawnLocalBin(bin, ["--quiet", "--format", "compact", file], { timeout: CHECK_TIMEOUT_MS, encoding: "utf8" });
    if (r.error || r.signal || r.status === 2 || r.status === null) return ""; // unavailable / no config / fatal → fail open
    if (r.status === 0) return ""; // clean (warnings suppressed by --quiet)
    const out = String(r.stdout || "").trim();
    return out ? `Lint errors in ${file}:\n${out}` : "";
  }
  if (lower.endsWith(".py")) {
    const bin = findLocalBin("ruff", file) || which("ruff");
    if (!bin) return "";
    const r = spawnLocalBin(bin, ["check", "--quiet", file], { timeout: CHECK_TIMEOUT_MS, encoding: "utf8" });
    if (r.error || r.signal || r.status === null) return "";
    if (r.status === 0) return "";
    const out = String(r.stdout || r.stderr || "").trim();
    return out ? `Ruff issues in ${file}:\n${out}` : "";
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

const OOXML_EXTS = new Set([".docx", ".xlsx", ".pptx"]);
const DEEP_SCAN_MAX = 20 * 1024 * 1024; // skip the deep read on huge files (fail open)

// Deep, deterministic validity beyond magic bytes. A file can have the right
// header yet be a broken deliverable (truncated OOXML zip, a PDF that never
// finished writing). Fail open: only flag when we're confident it's bad.
function checkDeepStructure(file, ext, size) {
  try {
    if (size > DEEP_SCAN_MAX) return "";
    if (OOXML_EXTS.has(ext)) {
      // Every valid OOXML package stores "[Content_Types].xml"; the entry name is
      // kept uncompressed in the zip, so a literal byte scan is reliable.
      const buf = fs.readFileSync(file);
      if (!buf.includes("[Content_Types].xml")) {
        return `File ${file} is not a valid ${ext} (missing [Content_Types].xml — the archive is truncated or not real OOXML). Regenerate it.`;
      }
    } else if (ext === ".pdf") {
      const tail = Buffer.alloc(Math.min(size, 1024));
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
      fs.closeSync(fd);
      if (!tail.includes("%%EOF")) {
        return `File ${file} is a truncated PDF (no %%EOF trailer). Regenerate it.`;
      }
    }
  } catch {
    /* fail open */
  }
  return "";
}

function checkStructure(file) {
  const ext = (file.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  if (ext === ".svg") return checkSvgStructure(file);
  const magics = EXT_MAGIC[ext];
  if (!magics) return "";
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return ""; }
  if (size === 0) return `Generated file is empty: ${file}`;
  const head = readHead(file);
  if (!head) return "";
  if (!matchesAny(head, magics)) {
    return `File ${file} does not look like a valid ${ext} (wrong header). Regenerate it properly.`;
  }
  return checkDeepStructure(file, ext, size);
}

function decodeXmlText(value = "") {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function attrsOf(attrText = "") {
  const attrs = {};
  for (const match of String(attrText || "").matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)) attrs[match[1].toLowerCase()] = match[2];
  for (const match of String(attrText || "").matchAll(/([:\w-]+)\s*=\s*'([^']*)'/g)) attrs[match[1].toLowerCase()] = match[2];
  for (const part of String(attrs.style || "").split(";")) {
    const [key, value] = part.split(":");
    if (key && value) attrs[key.trim().toLowerCase()] = value.trim();
  }
  return attrs;
}

function numberAttr(attrs, key, fallback = NaN) {
  const raw = attrs?.[key];
  if (raw == null) return fallback;
  const match = String(raw).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : fallback;
}

function translateOf(attrs = {}) {
  const match = String(attrs.transform || "").match(/translate\(\s*(-?\d+(?:\.\d+)?)(?:[\s,]+(-?\d+(?:\.\d+)?))?/i);
  return match ? { x: Number(match[1] || 0), y: Number(match[2] || 0) } : { x: 0, y: 0 };
}

function estimatedTextWidth(text, fontSize) {
  let width = 0;
  for (const char of Array.from(text)) {
    if (/\s/.test(char)) width += fontSize * 0.32;
    else if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) width += fontSize * 0.95;
    else width += fontSize * 0.58;
  }
  return Math.max(fontSize, width);
}

function boxForText(attrs, inherited, text) {
  const merged = { ...inherited, ...attrs };
  const fontSize = numberAttr(merged, "font-size", 14);
  const xRaw = numberAttr(merged, "x", NaN);
  const yRaw = numberAttr(merged, "y", NaN);
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;
  const shift = translateOf(merged);
  const x = xRaw + shift.x;
  const y = yRaw + shift.y;
  const width = estimatedTextWidth(text, fontSize);
  const height = fontSize * 1.2;
  const anchor = String(merged["text-anchor"] || "start").toLowerCase();
  const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  const top = y - fontSize * 0.9;
  return { left, right: left + width, top, bottom: top + height, text };
}

function collectSvgTextBoxes(svgText) {
  const boxes = [];
  for (const match of String(svgText || "").matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const textAttrs = attrsOf(match[1]);
    const body = match[2] || "";
    const tspanMatches = [...body.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi)];
    if (tspanMatches.length) {
      for (const tspan of tspanMatches) {
        const text = decodeXmlText(String(tspan[2] || "").replace(/<[^>]+>/g, "")).trim();
        if (text.length < 2) continue;
        const box = boxForText(attrsOf(tspan[1]), textAttrs, text);
        if (box) boxes.push(box);
      }
      continue;
    }
    const text = decodeXmlText(body.replace(/<[^>]+>/g, "")).trim();
    if (text.length < 2) continue;
    const box = boxForText(textAttrs, {}, text);
    if (box) boxes.push(box);
  }
  return boxes;
}

function overlapRatio(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const overlap = width * height;
  const areaA = Math.max(1, (a.right - a.left) * (a.bottom - a.top));
  const areaB = Math.max(1, (b.right - b.left) * (b.bottom - b.top));
  return overlap / Math.min(areaA, areaB);
}

function findSvgTextOverlap(svgText) {
  const boxes = collectSvgTextBoxes(svgText);
  if (boxes.length > 220) return null;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlapRatio(boxes[i], boxes[j]) >= 0.35) return [boxes[i].text, boxes[j].text];
    }
  }
  return null;
}

function checkSvgStructure(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return ""; }
  if (!/<svg\b/i.test(text)) {
    return `SVG check failed: ${file} does not contain an <svg> root. Regenerate it as a valid SVG document.`;
  }
  const overlap = findSvgTextOverlap(text);
  if (overlap) {
    return `SVG layout check failed: ${file} has overlapping text labels ("${overlap[0]}" and "${overlap[1]}"). Re-layout the SVG with larger boxes, separate y coordinates, wrapped <tspan> lines, or smaller text before declaring it done.`;
  }
  return "";
}

function svgPathsMentionedInOutput(outputText) {
  const paths = new Set();
  const pattern = /((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|generated-assets[\\/])[^"'`<>\s|]*?\.svg)\b/gi;
  for (const match of String(outputText || "").matchAll(pattern)) {
    const raw = String(match[1] || "").replace(/[),，。；;:：]+$/g, "");
    if (!raw) continue;
    const file = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") ? raw : path.resolve(process.cwd(), raw);
    paths.add(file);
  }
  return [...paths];
}

function checkGeneratedSvgMentions(outputText) {
  const issues = [];
  for (const file of svgPathsMentionedInOutput(outputText)) {
    if (!fs.existsSync(file)) {
      issues.push(`Bash output mentions generated SVG ${file} but the file does not exist. Generate it before declaring it.`);
      continue;
    }
    const issue = checkSvgStructure(file);
    if (issue) issues.push(issue);
  }
  return issues.join("\n");
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
      const ext = (file.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
      if (type === "image" && ext === ".svg") {
        const issue = checkSvgStructure(file);
        if (issue) issues.push(issue);
      } else if (type === "image" && !matchesAny(head, MEDIA_MAGIC.image)) issues.push(`${file} declared image but is not a valid image.`);
      if ((type === "audio" || type === "speech") && !matchesAny(head, MEDIA_MAGIC.audio)) issues.push(`${file} declared ${type} but is not valid audio.`);
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
          notes.push(checkSyntax(file), checkStructure(file), checkLint(file));
        }
      }
      if (tool === "bash") {
        const text = output?.output || "";
        notes.push(checkGeneratedMedia(text));
        if (/\.svg\b/i.test(text)) notes.push(checkGeneratedSvgMentions(text));
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
