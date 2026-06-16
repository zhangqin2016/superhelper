#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { assert } from "./lib/test-assert.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-stock-app-"));

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build-stock-workspace-app.mjs"),
      "--out",
      tmpDir,
      "--version",
      "test-platform-env",
      "--exported-at",
      "2026-06-16T00:00:00.000Z",
    ],
    { cwd: root, stdio: "pipe" },
  );

  const artifact = path.join(tmpDir, "daily-stock-analysis-test-platform-env.lilyspace.zip");
  assert(fs.existsSync(artifact), "stock app package is built");

  const zip = await JSZip.loadAsync(fs.readFileSync(artifact));
  const mainPy = await zip.file("files/source/main.py").async("string");
  const agentsMd = await zip.file("files/AGENTS.md").async("string");
  const platformGuide = await zip.file("files/source/LILY_PLATFORM.md").async("string");

  assert(mainPy.includes("from lily_run import main"), "packaged main.py delegates to Lily runner");
  assert(!mainPy.includes("TradingAgentsGraph"), "packaged main.py does not run upstream OpenAI-default demo");
  assert(agentsMd.includes("Do not ask ordinary users to configure upstream OpenAI/Anthropic/search keys"), "AGENTS forbids upstream key setup");
  assert(!agentsMd.includes("ask only for stock/data-provider keys"), "AGENTS no longer suggests key setup as normal flow");
  assert(platformGuide.includes("source/main.py` is packaged as a Lily compatibility wrapper"), "platform guide documents wrapper");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("PASS: test-stock-workspace-app-package");
