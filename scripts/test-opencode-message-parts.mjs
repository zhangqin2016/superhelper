#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOpencodePromptBody, fileToPart } = require("../src/main/runtime/opencode-message-parts.js");

{
  const body = buildOpencodePromptBody({
    agent: "build",
    guidance: "SYSTEM GUIDE",
    text: "user request",
    model: { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" },
  });
  assert.equal(body.system, "SYSTEM GUIDE", "guidance must use OpenCode's system field");
  assert.deepEqual(body.parts, [{ type: "text", text: "user request" }], "user parts contain only user content");
  assert.deepEqual(body.model, { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" }, "model ref carried");
}

{
  const body = buildOpencodePromptBody({ guidance: "  ", text: "hello" });
  assert.equal("system" in body, false, "blank guidance is omitted");
  assert.deepEqual(body.parts, [{ type: "text", text: "hello" }], "text-only prompt remains valid");
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-parts-"));
  const small = path.join(dir, "small.txt");
  fs.writeFileSync(small, "hello");
  const part = fileToPart({ path: small, name: "small.txt" }, { maxInlineFileBytes: 16 });
  assert.equal(part?.type, "file", "small files are still inlined");
  assert.equal(part.filename, "small.txt", "filename is preserved");
  assert.match(part.url, /^data:text\/plain;base64,/, "small local file becomes a data URL");

  const large = path.join(dir, "large.pdf");
  fs.writeFileSync(large, Buffer.alloc(32, 7));
  const skipped = [];
  const skippedPart = fileToPart(
    { path: large, name: "large.pdf" },
    { maxInlineFileBytes: 16, onSkip: (item) => skipped.push(item) },
  );
  assert.equal(skippedPart, null, "large local files are not inlined");
  assert.equal(skipped.length, 1, "large-file skip is reported");
  assert.equal(skipped[0].filename, "large.pdf", "skip report carries filename");

  const body = buildOpencodePromptBody({
    text: "read this",
    files: [{ path: large, name: "large.pdf" }],
    maxInlineFileBytes: 16,
  });
  assert.equal(body.parts.length, 1, "skipped file does not create a file part");
  assert.match(body.parts[0].text, /Attachment note/, "skipped file is explained to the model");
  assert.match(body.parts[0].text, /large\.pdf/, "skipped file name is included in the note");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("opencode-message-parts: ok");
