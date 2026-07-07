#!/usr/bin/env node
/**
 * Tool payload parsing must preserve structured fields (Write file_path + content),
 * not collapse into an opaque JSON string for display.
 */

import { normalizeToolResult, toolFilePath } from "../src/renderer/modules/tool-payload-renderer.js";

function parseToolInput(tool = {}) {
  if (tool.input && Object.keys(tool.input).length) {
    const copy = { ...tool.input };
    delete copy.preview;
    return copy;
  }
  if (!tool.partialJson) return null;
  try {
    const parsed = JSON.parse(tool.partialJson);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { __partialJson: tool.partialJson };
  }
}

function firstFilePath(obj = {}) {
  for (const key of ["file_path", "path", "target_file"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const writeInput = parseToolInput({
  name: "Write",
  input: {
    file_path: "/tmp/chapter.md",
    content: "# Title\n\nBody",
  },
});

if (!writeInput || writeInput.content !== "# Title\n\nBody") {
  console.error("tool-payload-renderer: Write content field lost");
  process.exit(1);
}
if (firstFilePath(writeInput) !== "/tmp/chapter.md") {
  console.error("tool-payload-renderer: Write file_path not extracted");
  process.exit(1);
}

const partial = parseToolInput({
  name: "Write",
  partialJson: '{"file_path":"/a.md","content":"x"}',
});
if (!partial || partial.file_path !== "/a.md") {
  console.error("tool-payload-renderer: partialJson not parsed");
  process.exit(1);
}

const broken = parseToolInput({
  name: "Write",
  partialJson: '{"file_path":"/a.md","content":"',
});
if (!broken?.__partialJson) {
  console.error("tool-payload-renderer: invalid partialJson should be preserved");
  process.exit(1);
}

// --- Generated-file detection (mirror of tool-payload-renderer internals) ---
// Skill scripts print JSON with output paths; we surface those for "reveal in
// folder". This is the pure detection logic; the DOM rendering isn't unit-tested
// (same as generatedMediaFromPayload), but wrong detection = no reveal affordance.
const GENERATED_FILE_EXTS = /\.(docx|xlsx|pptx|pdf|csv|md|txt|rtf|png|jpe?g|webp|gif|svg|mp4|webm|mov|m4v|mkv|mp3|wav|m4a|aac|ogg|flac|html?|json|zip)$/i;
function isPlaceholderGeneratedPath(filePath = "") {
  const raw = String(filePath || "").trim();
  if (!raw) return true;
  let normalized = raw.replace(/\\/g, "/");
  try { normalized = decodeURIComponent(normalized); } catch { /* keep raw */ }
  const lower = normalized.toLowerCase();
  return (
    /^\/(?:absolute\/path\/to|path\/to)\//.test(lower) ||
    /^[a-z]:\/(?:absolute\/path\/to|path\/to)\//.test(lower) ||
    lower.includes("/绝对路径/") ||
    /^\/?绝对路径\//.test(normalized) ||
    /(^|\/)(?:your|example|sample)-?path\//.test(lower)
  );
}
function looksLikeGeneratedFilePath(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length > 3 && /[\\/]/.test(text) && GENERATED_FILE_EXTS.test(text) && !isPlaceholderGeneratedPath(text);
}
function generatedFilesFromPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.ok === false) return [];
  const paths = [];
  if (looksLikeGeneratedFilePath(payload.output)) paths.push(payload.output.trim());
  for (const key of ["images", "outputs"]) {
    if (Array.isArray(payload[key])) {
      for (const entry of payload[key]) {
        const candidate = typeof entry === "string" ? entry : entry?.path;
        if (looksLikeGeneratedFilePath(candidate)) paths.push(candidate.trim());
      }
    }
  }
  const seen = new Set();
  return paths.filter((p) => (seen.has(p) ? false : seen.add(p))).map((path) => ({ path }));
}

function expectPaths(payload, expected, label) {
  const got = generatedFilesFromPayload(payload).map((f) => f.path);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`tool-payload-renderer: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    process.exit(1);
  }
}

// template-fill / pdf-form emit {ok, output}; render emits {ok, images:[...]}.
expectPaths({ ok: true, output: "/tmp/out/contract.docx", missing: [] }, ["/tmp/out/contract.docx"], "docx output");
expectPaths({ ok: true, images: ["/tmp/v/page-1.png", "/tmp/v/page-2.png"] }, ["/tmp/v/page-1.png", "/tmp/v/page-2.png"], "render images");
expectPaths({ ok: true, output: "/tmp/out/promo.mp4" }, ["/tmp/out/promo.mp4"], "video output");
expectPaths({ ok: true, outputs: [{ path: "/tmp/out/voice.wav" }] }, ["/tmp/out/voice.wav"], "audio output");
// A failed result must NOT offer a reveal to a file it didn't write.
expectPaths({ ok: false, output: "/tmp/out/contract.docx" }, [], "failed result → no reveal");
// Non-path strings (e.g. a status message) must not be mistaken for files.
expectPaths({ ok: true, output: "done" }, [], "non-path output ignored");
expectPaths({ ok: true, result: "Created the report." }, [], "prose result ignored");
expectPaths({ ok: true, output: "/absolute/path/to/generated-assets/name.svg" }, [], "placeholder generated path ignored");
// De-dupe repeated paths.
expectPaths({ ok: true, output: "/a/x.pdf", outputs: ["/a/x.pdf"] }, ["/a/x.pdf"], "dedupe");

// --- Process job display helpers (mirror of renderer internals) ---
// The platform's long-task contract exposes status/state/phase/heartbeat/progress
// and output file hints. The chat renderer must make those fields readable
// instead of burying them in an opaque JSON blob.
function formatProcessProgress(progress = null) {
  if (!progress || typeof progress !== "object") return "";
  const label = progress.label || progress.phase || progress.domain || "";
  const current = Number.isFinite(Number(progress.current)) ? Number(progress.current) : null;
  const total = Number.isFinite(Number(progress.total)) ? Number(progress.total) : null;
  const parts = [];
  if (label) parts.push(String(label));
  if (current != null && total != null && total > 0) parts.push(`${current}/${total}`);
  else if (current != null) parts.push(String(current));
  return parts.length ? parts.join(" · ") : JSON.stringify(progress);
}
function normalizeOutputFiles(files = []) {
  if (!Array.isArray(files)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of files) {
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    out.push({ path: filePath });
  }
  return out;
}
if (formatProcessProgress({ label: "page", current: 1, total: 3 }) !== "page · 1/3") {
  console.error("tool-payload-renderer: process progress summary lost");
  process.exit(1);
}
const jobFiles = normalizeOutputFiles(["/tmp/a.json", { path: "/tmp/a.json" }, { path: "/tmp/b.json" }]);
if (JSON.stringify(jobFiles) !== JSON.stringify([{ path: "/tmp/a.json" }, { path: "/tmp/b.json" }])) {
  console.error(`tool-payload-renderer: process outputFiles not normalized: ${JSON.stringify(jobFiles)}`);
  process.exit(1);
}
const normalizedJsonString = normalizeToolResult(JSON.stringify({ content: "short", truncated: true, fullText: "long" }));
if (JSON.stringify(normalizedJsonString) !== JSON.stringify({ content: "short", truncated: true, fullText: "long" })) {
  console.error(`tool-payload-renderer: normalizeToolResult lost JSON string metadata: ${JSON.stringify(normalizedJsonString)}`);
  process.exit(1);
}
const normalizedPlainString = normalizeToolResult("plain output");
if (JSON.stringify(normalizedPlainString) !== JSON.stringify({ content: "plain output", truncated: false, fullText: "" })) {
  console.error(`tool-payload-renderer: normalizeToolResult plain string fallback changed: ${JSON.stringify(normalizedPlainString)}`);
  process.exit(1);
}
if (toolFilePath({ name: "write", input: { file_path: "/tmp/a.md" } }) !== "/tmp/a.md") {
  console.error("tool-payload-renderer: write file_path extraction changed");
  process.exit(1);
}
if (toolFilePath({ name: "edit", input: { path: "/tmp/b.md" } }) !== "/tmp/b.md") {
  console.error("tool-payload-renderer: edit path extraction changed");
  process.exit(1);
}
if (toolFilePath({ name: "multiedit", input: { target_file: "/tmp/c.md" } }) !== "/tmp/c.md") {
  console.error("tool-payload-renderer: multiedit target_file extraction changed");
  process.exit(1);
}
if (toolFilePath({ name: "read", input: { path: "/tmp/read.md" } }) !== "") {
  console.error("tool-payload-renderer: non-edit tools should not expose a row file path");
  process.exit(1);
}
const rendererSource = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/renderer/modules/tool-payload-renderer.js", import.meta.url), "utf8"));
if (!rendererSource.includes("renderProcessJobPayload") || !rendererSource.includes("outputFiles")) {
  console.error("tool-payload-renderer: process job renderer missing");
  process.exit(1);
}
const turnRendererSource = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url), "utf8"));
if (/function normalizeToolResult\s*\(/.test(turnRendererSource)) {
  console.error("tool-payload-renderer: turn renderer should consume normalizeToolResult from tool-payload-renderer");
  process.exit(1);
}
if (/function toolFilePath\s*\(/.test(turnRendererSource)) {
  console.error("tool-payload-renderer: turn renderer should consume toolFilePath from tool-payload-renderer");
  process.exit(1);
}

console.log("tool-payload-renderer: ok");
