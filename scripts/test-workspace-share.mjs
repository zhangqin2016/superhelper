#!/usr/bin/env node
/**
 * Workspace capability packs: a pack must carry the workspace's files,
 * exclude personal/noise dirs by location, ship learned conventions and a
 * required-skills declaration, survive an export→import round trip, and
 * reject zip-slip and future-schema packs on import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const share = require("../src/main/workspace-share.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-share-test-"));

try {
  // Build a workspace with capability files + things that must be excluded.
  const ws = path.join(tmp, "suanming");
  fs.mkdirSync(path.join(ws, "knowledge/bazi"), { recursive: true });
  fs.mkdirSync(path.join(ws, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(ws, "output"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".lily-work"), { recursive: true });
  fs.mkdirSync(path.join(ws, "node_modules/pkg"), { recursive: true });
  fs.mkdirSync(path.join(ws, "dist"), { recursive: true });
  fs.mkdirSync(path.join(ws, "build"), { recursive: true });
  fs.writeFileSync(path.join(ws, "knowledge/bazi/rules.md"), "排盘规则");
  fs.writeFileSync(path.join(ws, "scripts/generate.py"), "print(1)");
  fs.writeFileSync(path.join(ws, ".cursorrules"), "用专业术语");
  fs.writeFileSync(path.join(ws, "output", "张钦_命理.pdf"), "PRIVATE");
  fs.writeFileSync(path.join(ws, ".lily-work", "tmp.txt"), "scratch");
  fs.writeFileSync(path.join(ws, "node_modules/pkg/index.js"), "x");
  fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
  // Env template (config shape, no real secret) — must travel so the source runs.
  fs.writeFileSync(path.join(ws, ".env.example"), "OPENAI_API_KEY=\nPORT=3000\n");
  // The program's build artifacts ARE part of the deliverable — must ship.
  fs.writeFileSync(path.join(ws, "dist/index.html"), "<html>built site</html>");
  fs.writeFileSync(path.join(ws, "build/app.js"), "console.log('built')");
  // A key hardcoded into a shared source file — must be flagged (not silently shipped).
  fs.writeFileSync(path.join(ws, "scripts/config.js"), 'const apiKey = "sk-ant-abc123def456ghi789jkl";');

  const skillDir = path.join(tmp, "skills", "learned-oa-portal");
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# OA Portal\n\nUse the learned OA playbook.");
  fs.writeFileSync(path.join(skillDir, "scripts", "run.cjs"), "console.log('oa')");
  fs.writeFileSync(path.join(skillDir, "skill.manifest.json"), JSON.stringify({
    id: "learned-oa-portal",
    name: "OA Portal",
    version: "1.0.0",
    publisher: "Workspace",
    origin: "workspace",
    workspaceOnly: true,
  }, null, 2));

  // Preview: personal/noise/secret-file locations excluded; capability files +
  // build artifacts kept; content secrets flagged.
  const preview = share.previewExport(ws);
  const rels = share.listShareableFiles(ws).map((f) => f.relPath).sort();
  if (rels.some((r) => r.startsWith("output/") || r.startsWith(".lily-work/") || r.includes("node_modules") || r === ".env")) {
    throw new Error(`excluded locations leaked: ${rels.join(", ")}`);
  }
  if (!rels.includes("knowledge/bazi/rules.md") || !rels.includes(".cursorrules") || !rels.includes("scripts/generate.py")) {
    throw new Error(`capability files missing: ${rels.join(", ")}`);
  }
  // Build artifacts (the actual program) must travel — not be excluded like before.
  if (!rels.includes("dist/index.html") || !rels.includes("build/app.js")) {
    throw new Error(`program build artifacts must be included: ${rels.join(", ")}`);
  }
  // Env template kept (so source is runnable); real .env still excluded.
  if (!rels.includes(".env.example")) throw new Error(".env.example template must be included");
  if (rels.includes(".env")) throw new Error("real .env must stay excluded");
  // The hardcoded key must be flagged so the author can scrub before sharing.
  if (!preview.secretWarnings?.some((w) => w.relPath === "scripts/config.js")) {
    throw new Error(`secret content scan must flag scripts/config.js: ${JSON.stringify(preview.secretWarnings)}`);
  }
  if (preview.fileCount !== rels.length) throw new Error("preview count mismatch");

  // Export → import round trip.
  const buf = await share.exportWorkspacePack({
    rootPath: ws,
    name: "算命大师",
    description: "八字命理工作区",
    conventions: "- 报告用宋体\n- 先排盘再断语",
    requiredSkills: ["lily-image-generation"],
    workspaceSkills: [{
      id: "learned-oa-portal",
      dir: skillDir,
      enabled: true,
    }],
    exportedAt: "2026-06-12T00:00:00.000Z",
  });
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error("export produced no bytes");

  const dest = path.join(tmp, "imported");
  const { manifest, conventions, workspaceSkills } = await share.importWorkspacePack(buf, dest);
  if (manifest.name !== "算命大师" || manifest.schemaVersion !== share.SCHEMA_VERSION) {
    throw new Error(`manifest round trip failed: ${JSON.stringify(manifest)}`);
  }
  if (manifest.requiredSkills.join(",") !== "lily-image-generation") {
    throw new Error("requiredSkills must survive the round trip");
  }
  if (!conventions.includes("报告用宋体")) throw new Error("conventions must travel with the pack");
  if (!manifest.workspaceSkills?.some((skill) => skill.id === "learned-oa-portal" && skill.enabled === true)) {
    throw new Error(`workspace skill manifest must travel: ${JSON.stringify(manifest.workspaceSkills)}`);
  }
  if (workspaceSkills.length !== 1 || workspaceSkills[0].id !== "learned-oa-portal") {
    throw new Error(`workspace skill import metadata missing: ${JSON.stringify(workspaceSkills)}`);
  }
  if (!fs.existsSync(path.join(dest, ".lily-work/imported-skills/learned-oa-portal/SKILL.md"))) {
    throw new Error("workspace skill files must be extracted into the imported workspace");
  }
  if (fs.readFileSync(path.join(dest, "knowledge/bazi/rules.md"), "utf8") !== "排盘规则") {
    throw new Error("capability file content corrupted on import");
  }
  if (fs.existsSync(path.join(dest, "output")) || fs.existsSync(path.join(dest, ".env"))) {
    throw new Error("excluded files must not appear in the imported workspace");
  }

  // Security layer 1: safeJoin rejects any path resolving outside the target.
  let guardFired = false;
  try { share.safeJoin(path.join(tmp, "t"), "../../escaped.txt"); }
  catch (e) { guardFired = e.message.includes("UNSAFE_PATH"); }
  if (!guardFired) throw new Error("safeJoin must reject traversal paths");
  if (share.safeJoin(path.join(tmp, "t"), "a/b.txt") !== path.resolve(tmp, "t/a/b.txt")) {
    throw new Error("safeJoin must allow in-tree paths");
  }

  // Security layer 2: a crafted traversal entry must never escape to disk on
  // a real import (JSZip normalization + the files/ prefix filter + safeJoin).
  const evil = new JSZip();
  evil.file(share.MANIFEST_NAME, JSON.stringify({ kind: "lily-workspace-pack", schemaVersion: 1, requiredSkills: [] }));
  evil.file("files/../../escaped.txt", "pwned");
  const evilBuf = await evil.generateAsync({ type: "nodebuffer" });
  await share.importWorkspacePack(evilBuf, path.join(tmp, "evil-dest")).catch(() => {});
  if (fs.existsSync(path.join(tmp, "escaped.txt"))) throw new Error("zip-slip wrote outside the target!");

  // Reject non-packs and future schema versions.
  const emptyPack = new JSZip();
  emptyPack.file(share.MANIFEST_NAME, JSON.stringify({ kind: "lily-workspace-pack", schemaVersion: 1, requiredSkills: [] }));
  let rejectedEmpty = false;
  try { await share.importWorkspacePack(await emptyPack.generateAsync({ type: "nodebuffer" }), path.join(tmp, "empty-dest")); }
  catch (e) { rejectedEmpty = e.message === "WORKSPACE_PACK_EMPTY"; }
  if (!rejectedEmpty) throw new Error("an empty workspace pack must be rejected before creating a misleading empty workspace");

  const notPack = await new JSZip().generateAsync({ type: "nodebuffer" });
  let rejectedPlain = false;
  try { await share.readPackManifest(notPack); } catch (e) { rejectedPlain = e.message === "NOT_A_WORKSPACE_PACK"; }
  if (!rejectedPlain) throw new Error("a plain zip must be rejected");

  const future = new JSZip();
  future.file(share.MANIFEST_NAME, JSON.stringify({ kind: "lily-workspace-pack", schemaVersion: 99 }));
  let rejectedFuture = false;
  try { await share.readPackManifest(await future.generateAsync({ type: "nodebuffer" })); }
  catch (e) { rejectedFuture = e.message === "PACK_TOO_NEW"; }
  if (!rejectedFuture) throw new Error("a newer-schema pack must be rejected");

  console.log("workspace-share: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
