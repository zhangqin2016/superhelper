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
const videoPath = path.join(outputDir, "promo.mp4");
fs.writeFileSync(videoPath, "fake mp4");
const audioPath = path.join(outputDir, "voice.wav");
fs.writeFileSync(audioPath, "fake wav");
const skillDir = path.join(workspace, "resources", "skills-catalog", "lily-example", "references");
fs.mkdirSync(skillDir, { recursive: true });
const skillDependencyPath = path.join(skillDir, "guide.md");
fs.writeFileSync(skillDependencyPath, "# Skill dependency\n");
const outsidePath = path.join(os.tmpdir(), "outside-lily-artifact.svg");
fs.writeFileSync(outsidePath, "<svg></svg>");

function setFileMtime(filePath, ms) {
  const date = new Date(ms);
  fs.utimesSync(filePath, date, date);
}

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
    assert.match(artifacts[0].artifactId, /^art_/, "turn artifacts carry stable artifact ids");
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
      assistantText: "视频和配音已生成：output/promo.mp4、output/voice.wav",
    });
    assert.deepEqual(artifacts.map((item) => item.relativePath), ["output/promo.mp4", "output/voice.wav"]);
    assert.equal(artifacts[0].kind, "video");
    assert.equal(artifacts[0].mimeType, "video/mp4");
    assert.equal(artifacts[1].kind, "audio");
    assert.equal(artifacts[1].mimeType, "audio/wav");
  }

  {
    const turnStart = Date.now();
    setFileMtime(pdfPath, turnStart - 60_000);
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      startedAt: turnStart,
      assistantText: "上次生成的是 output/report.pdf，这次没有修改这个文件。",
    });
    assert.equal(artifacts.length, 0, "stale assistant-text path must not become a current turn artifact");
  }

  {
    const turnStart = Date.now();
    const freshPath = path.join(outputDir, "fresh-current-turn.pdf");
    fs.writeFileSync(freshPath, "%PDF-1.4\nfresh");
    setFileMtime(freshPath, turnStart + 1_000);
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      startedAt: turnStart,
      assistantText: "已生成 output/fresh-current-turn.pdf。",
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].relativePath, "output/fresh-current-turn.pdf");
  }

  {
    const turnStart = Date.now();
    setFileMtime(pdfPath, turnStart - 60_000);
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      startedAt: turnStart,
      tools: [{
        id: "tool_bash_old_output",
        name: "Bash",
        startedAt: turnStart,
        result: { ok: true, output: "output/report.pdf" },
      }],
    });
    assert.equal(artifacts.length, 0, "stale tool output path must not become a current turn artifact");
  }

  {
    const turnStart = Date.now();
    setFileMtime(pdfPath, turnStart - 60_000);
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      startedAt: turnStart,
      fileChanges: [{ filePath: pdfPath }],
    });
    assert.equal(artifacts.length, 1, "explicit file changes still count even when the file mtime is old");
    assert.equal(artifacts[0].relativePath, "output/report.pdf");
  }

  {
    const turnStart = Date.now();
    setFileMtime(pdfPath, turnStart - 60_000);
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      startedAt: turnStart,
      expectedArtifactPaths: [pdfPath],
    });
    assert.equal(artifacts.length, 1, "delivery QA inherits the original artifact despite its older mtime");
    assert.equal(artifacts[0].relativePath, "output/report.pdf");
    assert.equal(artifacts[0].source, "inherited_delivery");
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
    // A knowledge/reference file READ this turn must NOT become a deliverable even
    // when the model cites its path in prose; a written output cited alongside it
    // still shows. (Regression: the whole read knowledge base rendered as cards.)
    const knowledgeDir = path.join(workspace, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const refPath = path.join(knowledgeDir, "ziwei-master.md");
    fs.writeFileSync(refPath, "# 紫微规则\n");
    const agentsPath = path.join(workspace, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# guide\n");
    const artifacts = buildTurnArtifacts({
      workspacePath: workspace,
      tools: [{ id: "r1", name: "Read", input: { file_path: "knowledge/ziwei-master.md" } }],
      assistantText: "参考了 knowledge/ziwei-master.md 与 AGENTS.md，已生成 output/张钦_八字命理全面分析_2026.md。",
    });
    assert.deepEqual(artifacts.map((a) => a.relativePath), ["output/张钦_八字命理全面分析_2026.md"]);
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
