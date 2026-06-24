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
const mdPath = path.join(outputDir, "张钦_八字命理全面分析_2026.md");
fs.writeFileSync(mdPath, "# 命理全面分析\n\n报告正文");
const skillDir = path.join(workspace, "resources", "skills-catalog", "lily-example", "references");
fs.mkdirSync(skillDir, { recursive: true });
const skillDependencyPath = path.join(skillDir, "guide.md");
fs.writeFileSync(skillDependencyPath, "# Skill dependency\n");
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
      assistantText: "报告已生成完毕，保存在 output/张钦_八字命理全面分析_2026.md。",
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "file");
    assert.equal(artifacts[0].path, mdPath);
    assert.equal(artifacts[0].relativePath, "output/张钦_八字命理全面分析_2026.md");
    assert.equal(artifacts[0].mimeType, "text/markdown");
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

  {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      tools: [{ id: "tool_write", name: "Write", input: { file_path: "output/report.pdf" } }],
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].source, "tool_write");
  }

  {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      tools: [{ id: "tool_bash", name: "Bash", result: `Loaded dependency ${skillDependencyPath}` }],
      assistantText: `参考资料：resources/skills-catalog/lily-example/references/guide.md`,
    });
    assert.equal(artifacts.length, 0);
  }

  {
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      fileChanges: [{ filePath: skillDependencyPath }],
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].relativePath, "resources/skills-catalog/lily-example/references/guide.md");
  }

  console.log("turn artifact extraction ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outsidePath, { force: true });
}
