import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTurnArtifacts } = require("../src/main/turn-artifacts.js");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-turn-artifacts-"));
const outputDir = path.join(workspace, "output");
fs.mkdirSync(outputDir, { recursive: true });
const svgPath = path.join(outputDir, "bug-distribution.svg");
fs.writeFileSync(svgPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\" /></svg>");
const pdfPath = path.join(outputDir, "report.pdf");
fs.writeFileSync(pdfPath, "%PDF-1.4\n");
const outsidePath = path.join(os.tmpdir(), "outside-lily-artifact.svg");
fs.writeFileSync(outsidePath, "<svg></svg>");

try {
  {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      assistantText: "SVG 已生成：output/bug-distribution.svg",
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "image");
    assert.equal(artifacts[0].path, svgPath);
    assert.equal(artifacts[0].relativePath, "output/bug-distribution.svg");
  }

  {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      assistantText: `不要预览工作区外文件 ${outsidePath}`,
    });
    assert.equal(artifacts.length, 0);
  }

  {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      fileChanges: [{ filePath: svgPath }],
      tools: [{ id: "tool_1", result: { ok: true, output: "output/report.pdf" } }],
      assistantText: "SVG 已生成：output/bug-distribution.svg",
    });
    assert.equal(artifacts.length, 2);
    assert.deepEqual(artifacts.map((item) => item.relativePath), [
      "output/bug-distribution.svg",
      "output/report.pdf",
    ]);
    assert.equal(artifacts[0].source, "file_change,assistant_text");
  }

  {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      tools: [{ id: "tool_read", name: "Read", input: { file_path: "output/bug-distribution.svg" } }],
    });
    assert.equal(artifacts.length, 0);
  }

  console.log("turn artifact extraction ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outsidePath, { force: true });
}
