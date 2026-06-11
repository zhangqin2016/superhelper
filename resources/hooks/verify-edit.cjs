#!/usr/bin/env node
"use strict";
// PostToolUse verification hook: after the engine edits a file (or a skill
// claims it generated one), run fast deterministic checks. Exit 2 feeds
// stderr back to the model so it self-corrects before the user ever sees the
// breakage; anything we cannot check confidently FAILS OPEN (exit 0) — a
// hook must never produce false positives or block on a slow/missing checker.
//
// Coverage:
//   - Edit/Write/MultiEdit: syntax (js/json/py) and file-format structure
//     (office docs, pdf, images must start with the right magic bytes).
//   - Bash: <generated_media> declarations in the tool output — a skill that
//     claims it produced a file must have actually produced a valid one.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const CHECK_TIMEOUT_MS = 10_000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

function fail(message) {
  process.stderr.write(String(message).slice(0, 2000));
  process.exit(2);
}

function checkJavaScript(file) {
  // process.execPath is node (or the app's node shim with
  // ELECTRON_RUN_AS_NODE inherited via env), so --check is always available.
  const result = spawnSync(process.execPath, ["--check", file], {
    timeout: CHECK_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (result.error || result.signal) return;
  if (result.status !== 0) {
    fail(`Syntax check failed for ${file}:\n${result.stderr || result.stdout || ""}`);
  }
}

function checkJson(file) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`JSON syntax error in ${file}: ${error.message}`);
  }
}

function checkPython(file) {
  for (const python of ["python3", "python"]) {
    const result = spawnSync(python, ["-m", "py_compile", file], {
      timeout: CHECK_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.error) continue; // interpreter not installed — try next, else skip
    if (result.signal) return;
    if (result.status !== 0) {
      fail(`Python syntax check failed for ${file}:\n${result.stderr || result.stdout || ""}`);
    }
    return;
  }
}

// --- File-format structure checks (documents, images) -----------------------
// Magic-byte tables: only formats we can identify with certainty. A wrong
// magic on a freshly written .docx/.png means the file is broken for the
// user even though the tool call "succeeded".
const MAGIC = {
  zip: [Buffer.from("PK\x03\x04", "binary"), Buffer.from("PK\x05\x06", "binary")],
  pdf: [Buffer.from("%PDF")],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  gif: [Buffer.from("GIF8")],
  webp: [Buffer.from("RIFF")],
  mp3: [Buffer.from("ID3"), Buffer.from([0xff, 0xfb]), Buffer.from([0xff, 0xf3])],
  wav: [Buffer.from("RIFF")],
  ogg: [Buffer.from("OggS")],
  webm: [Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
};
const EXT_MAGIC = {
  ".docx": MAGIC.zip, ".xlsx": MAGIC.zip, ".pptx": MAGIC.zip, ".zip": MAGIC.zip,
  ".pdf": MAGIC.pdf,
  ".png": MAGIC.png, ".jpg": MAGIC.jpg, ".jpeg": MAGIC.jpg,
  ".gif": MAGIC.gif, ".webp": MAGIC.webp,
};
const MEDIA_TYPE_MAGIC = {
  image: [...MAGIC.png, ...MAGIC.jpg, ...MAGIC.gif, ...MAGIC.webp],
  audio: [...MAGIC.mp3, ...MAGIC.wav, ...MAGIC.ogg],
  // mp4/mov carry "ftyp" at offset 4 — checked separately below.
  video: [...MAGIC.webm, ...MAGIC.wav],
};

function readHead(file, bytes = 16) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, read);
  } catch {
    return null;
  }
}

function matchesAny(head, magics) {
  return magics.some((magic) => head.length >= magic.length && head.subarray(0, magic.length).equals(magic));
}

function checkFileStructure(file) {
  const ext = (file.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  const magics = EXT_MAGIC[ext];
  if (!magics) return;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size === 0) fail(`Generated file is empty: ${file}`);
  const head = readHead(file);
  if (!head) return;
  if (!matchesAny(head, magics)) {
    fail(`File format check failed: ${file} does not look like a valid ${ext} file (wrong file header). Regenerate it properly.`);
  }
}

// --- generated_media fulfillment ---------------------------------------------
// Skills declare outputs as <generated_media type="image"><file path="..."/>.
// The declaration is a promise to the user; verify it was kept.
function isVideoHead(head) {
  return matchesAny(head, MEDIA_TYPE_MAGIC.video) ||
    (head.length >= 8 && head.subarray(4, 8).toString("binary") === "ftyp");
}

function checkGeneratedMedia(outputText) {
  const blocks = [...String(outputText).matchAll(/<generated_media\s+type="([^"]*)"[\s\S]*?<\/generated_media>/g)];
  for (const [block, type] of blocks) {
    for (const fileMatch of block.matchAll(/<file\s+path="([^"]+)"/g)) {
      const file = fileMatch[1].replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
      if (!fs.existsSync(file)) {
        fail(`generated_media declares ${file} but the file does not exist. Generate the file before declaring it.`);
      }
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size === 0) fail(`generated_media file is empty: ${file}. Regenerate it.`);
      const head = readHead(file);
      if (!head) continue;
      if (type === "image" && !matchesAny(head, MEDIA_TYPE_MAGIC.image)) {
        fail(`generated_media declares ${file} as an image but it is not a valid image file. Regenerate it.`);
      }
      if (type === "audio" && !matchesAny(head, MEDIA_TYPE_MAGIC.audio)) {
        fail(`generated_media declares ${file} as audio but it is not a valid audio file. Regenerate it.`);
      }
      if (type === "video" && !isVideoHead(head)) {
        fail(`generated_media declares ${file} as video but it is not a valid video file. Regenerate it.`);
      }
    }
  }
}

function toolResponseText(payload) {
  const response = payload?.tool_response;
  if (typeof response === "string") return response;
  if (response && typeof response.content === "string") return response.content;
  if (Array.isArray(response?.content)) {
    return response.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

function main(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const toolName = String(payload?.tool_name || "");

  if (toolName === "Bash") {
    const output = toolResponseText(payload);
    if (output.includes("<generated_media")) checkGeneratedMedia(output);
    process.exit(0);
  }

  if (!EDIT_TOOLS.has(toolName)) process.exit(0);
  const file = String(payload?.tool_input?.file_path || "");
  if (!file || !fs.existsSync(file)) process.exit(0);

  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) checkJson(file);
  else if (/\.(js|cjs|mjs)$/.test(lower)) checkJavaScript(file);
  else if (lower.endsWith(".py")) checkPython(file);
  else checkFileStructure(file);
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => main(input));
