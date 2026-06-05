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

console.log("tool-payload-renderer: ok");
