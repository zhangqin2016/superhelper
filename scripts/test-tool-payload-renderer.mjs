#!/usr/bin/env node
/**
 * Tool payload parsing must preserve structured fields (Write file_path + content),
 * not collapse into an opaque JSON string for display.
 */

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
const GENERATED_FILE_EXTS = /\.(docx|xlsx|pptx|pdf|csv|md|txt|rtf|png|jpe?g|webp|gif|svg|html?|json|zip)$/i;
function looksLikeGeneratedFilePath(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length > 3 && /[\\/]/.test(text) && GENERATED_FILE_EXTS.test(text);
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
// A failed result must NOT offer a reveal to a file it didn't write.
expectPaths({ ok: false, output: "/tmp/out/contract.docx" }, [], "failed result → no reveal");
// Non-path strings (e.g. a status message) must not be mistaken for files.
expectPaths({ ok: true, output: "done" }, [], "non-path output ignored");
expectPaths({ ok: true, result: "Created the report." }, [], "prose result ignored");
// De-dupe repeated paths.
expectPaths({ ok: true, output: "/a/x.pdf", outputs: ["/a/x.pdf"] }, ["/a/x.pdf"], "dedupe");

console.log("tool-payload-renderer: ok");
