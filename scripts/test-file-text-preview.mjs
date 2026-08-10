#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readTextPreview } = require("../src/main/ipc-files.js");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-text-preview-"));
const mdPath = path.join(workspace, "report.md");
const yamlPath = path.join(workspace, "config.yaml");
const rubyPath = path.join(workspace, "worker.rb");
const pngPath = path.join(workspace, "image.png");
fs.writeFileSync(mdPath, "# Report\n\n正文");
fs.writeFileSync(yamlPath, "name: Lily\nenabled: true\n");
fs.writeFileSync(rubyPath, "puts 'preview'\n");
fs.writeFileSync(pngPath, "not really an image");

try {
  {
    const result = readTextPreview({ filePath: mdPath });
    assert.equal(result.ok, true);
    assert.equal(result.text, "# Report\n\n正文");
    assert.equal(result.truncated, false);
  }

  {
    const result = readTextPreview({ filePath: mdPath, maxBytes: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.text, "# Re");
    assert.equal(result.truncated, true);
  }

  {
    const result = readTextPreview({ filePath: yamlPath });
    assert.equal(result.ok, true);
    assert.equal(result.text, "name: Lily\nenabled: true\n");
  }

  {
    const result = readTextPreview({ filePath: rubyPath });
    assert.equal(result.ok, true);
    assert.equal(result.text, "puts 'preview'\n");
  }

  {
    const result = readTextPreview({ filePath: pngPath });
    assert.equal(result.ok, false);
    assert.equal(result.error, "UNSUPPORTED_TYPE");
  }

  console.log("file text preview ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
