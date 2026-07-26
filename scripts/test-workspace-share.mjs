#!/usr/bin/env node
/**
 * Workspace capability packs: a pack must carry the workspace's files,
 * exclude dependency/noise dirs by location, ship learned conventions and a
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
  fs.mkdirSync(path.join(ws, "cases"), { recursive: true });
  fs.mkdirSync(path.join(ws, "output"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".lily-work/app-data"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".lily-work/cache"), { recursive: true });
  fs.mkdirSync(path.join(ws, "node_modules/pkg"), { recursive: true });
  fs.mkdirSync(path.join(ws, "dist"), { recursive: true });
  fs.mkdirSync(path.join(ws, "build"), { recursive: true });
  fs.writeFileSync(path.join(ws, "lily-app.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "clinical-case-assistant",
    type: "workspace_app",
    name: "临床病例参考助手",
    version: "0.1.0",
    export: { dataPaths: ["cases/", ".lily-work/app-data/"] },
    dataPolicy: { dataLocation: "workspace-internal (cases/)" },
  }, null, 2));
  fs.writeFileSync(path.join(ws, "knowledge/bazi/rules.md"), "排盘规则");
  fs.writeFileSync(path.join(ws, "README.md"), "# 算命大师\n");
  fs.writeFileSync(path.join(ws, "scripts/generate.py"), "print(1)");
  fs.writeFileSync(path.join(ws, "cases", "P-1.case.json"), JSON.stringify({ caseId: "P-1", problems: [{ name: "SLE" }] }));
  fs.writeFileSync(path.join(ws, ".lily-work", "app-data", "facts.json"), JSON.stringify({ learned: true }));
  fs.writeFileSync(path.join(ws, ".lily-work", "cache", "scratch.json"), JSON.stringify({ cache: true }));
  fs.writeFileSync(path.join(ws, ".cursorrules"), "用专业术语");
  fs.writeFileSync(path.join(ws, "output", "张钦_命理.pdf"), "PRIVATE");
  fs.closeSync(fs.openSync(path.join(ws, "huge-video.mov"), "w"));
  fs.truncateSync(path.join(ws, "huge-video.mov"), share.MAX_FILE_BYTES + 1);
  fs.writeFileSync(path.join(ws, ".lily-work", "tmp.txt"), "scratch");
  fs.writeFileSync(path.join(ws, "node_modules/pkg/index.js"), "x");
  fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(ws, ".DS_Store"), "finder noise");
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
  fs.writeFileSync(path.join(skillDir, "scripts", "run.cjs"), "const baseUrl = 'https://oa.customer.example.com'; console.log('portal_token')");
  fs.writeFileSync(path.join(skillDir, "skill.manifest.json"), JSON.stringify({
    id: "learned-oa-portal",
    name: "OA Portal",
    version: "1.0.0",
    publisher: "Workspace",
    origin: "workspace",
    workspaceOnly: true,
  }, null, 2));

  // Preview: dependency/noise/secret-file locations excluded; customer outputs,
  // capability files + build artifacts kept; content secrets flagged.
  const preview = share.previewExport(ws);
  const rels = share.listShareableFiles(ws, { includePaths: preview.workspaceApp?.dataPaths || [] }).map((f) => f.relPath).sort();
  if (rels.some((r) => r === ".lily-work/tmp.txt" || r.startsWith(".lily-work/cache/") || r.includes("node_modules") || r === ".env" || r === "huge-video.mov")) {
    throw new Error(`excluded locations leaked: ${rels.join(", ")}`);
  }
  if (!rels.includes("knowledge/bazi/rules.md") || !rels.includes(".cursorrules") || !rels.includes("scripts/generate.py")) {
    throw new Error(`capability files missing: ${rels.join(", ")}`);
  }
  if (!rels.includes("cases/P-1.case.json") || !rels.includes(".lily-work/app-data/facts.json")) {
    throw new Error(`declared app data must be exported, even under default-excluded parents: ${rels.join(", ")}`);
  }
  if (!rels.includes("output/张钦_命理.pdf")) {
    throw new Error(`customer deliverables under output/ must be exported by default: ${rels.join(", ")}`);
  }
  if (!preview.skippedFiles?.some((file) => file.relPath === "huge-video.mov" && file.reason === "too-large")) {
    throw new Error(`oversized files must be surfaced instead of silently skipped: ${JSON.stringify(preview.skippedFiles)}`);
  }
  if (preview.skippedFiles?.some((file) => file.relPath === ".DS_Store")) {
    throw new Error(`benign system files should not create scary skipped-file warnings: ${JSON.stringify(preview.skippedFiles)}`);
  }
  if (preview.workspaceApp?.appId !== "clinical-case-assistant") {
    throw new Error(`workspace app metadata must be detected: ${JSON.stringify(preview.workspaceApp)}`);
  }
  if (!preview.appDataPaths?.some((item) => item.path === "cases/" && item.fileCount === 1)) {
    throw new Error(`cases/ must be surfaced as app data in preview: ${JSON.stringify(preview.appDataPaths)}`);
  }
  if (!preview.appDataPaths?.some((item) => item.path === ".lily-work/app-data/" && item.fileCount === 1)) {
    throw new Error(`declared .lily-work/app-data must be surfaced in preview: ${JSON.stringify(preview.appDataPaths)}`);
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

  const skillPreview = share.previewWorkspaceSkills([{
    id: "learned-oa-portal",
    dir: skillDir,
    enabled: true,
  }]);
  if (skillPreview.length !== 1 || skillPreview[0].id !== "learned-oa-portal") {
    throw new Error(`workspace skill preview missing: ${JSON.stringify(skillPreview)}`);
  }
  const riskKinds = new Set((skillPreview[0].riskWarnings || []).map((warning) => warning.kind));
  if (!riskKinds.has("domain") || !riskKinds.has("credential-term") || !riskKinds.has("workspace-identity")) {
    throw new Error(`learned web skill risks must be surfaced: ${JSON.stringify(skillPreview[0].riskWarnings)}`);
  }

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
  const exportedZip = await JSZip.loadAsync(buf);
  if (!exportedZip.file("README.md") || !exportedZip.file("scripts/generate.py") || !exportedZip.file("output/张钦_命理.pdf")) {
    throw new Error("exported zip must open as a normal workspace at the root, not hide user files under files/");
  }
  if (!exportedZip.file(`${share.PACK_META_PREFIX}${share.MANIFEST_NAME}`)) {
    throw new Error("workspace metadata must live under hidden .lilyspace/");
  }
  if (!exportedZip.file("files/README.md") || !exportedZip.file(share.MANIFEST_NAME) || !exportedZip.file("conventions.md")) {
    throw new Error("exports must carry a legacy-compatible mirror so older Lily clients can import shared apps");
  }
  if (!exportedZip.file(`${share.PACK_SKILLS_PREFIX}learned-oa-portal/SKILL.md`)) {
    throw new Error("workspace skill metadata must live under hidden .lilyspace/skills/");
  }
  if (!exportedZip.file(`${share.SKILLS_PREFIX}learned-oa-portal/SKILL.md`)) {
    throw new Error("workspace skill metadata must also be mirrored for older importers");
  }
  const legacyManifest = JSON.parse(await exportedZip.file(share.MANIFEST_NAME).async("string"));
  if (legacyManifest.kind !== "lily-workspace-pack" || legacyManifest.originalKind !== "lily-workspace-app" || legacyManifest.appId !== "clinical-case-assistant") {
    throw new Error(`legacy manifest must be accepted by older pack importers while preserving app identity: ${JSON.stringify(legacyManifest)}`);
  }
  const legacyDest = path.join(tmp, "legacy-imported");
  fs.mkdirSync(legacyDest, { recursive: true });
  for (const entry of Object.values(exportedZip.files).filter((e) => !e.dir && e.name.startsWith("files/"))) {
    const rel = entry.name.slice("files/".length);
    if (!rel) continue;
    const destPath = path.join(legacyDest, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, await entry.async("nodebuffer"));
  }
  if (!fs.existsSync(path.join(legacyDest, "README.md")) || !fs.existsSync(path.join(legacyDest, "cases/P-1.case.json"))) {
    throw new Error("legacy-compatible mirror must let older importers restore the workspace files");
  }

  const dest = path.join(tmp, "imported");
  const { manifest, conventions, workspaceSkills } = await share.importWorkspacePack(buf, dest);
  if (manifest.name !== "算命大师" || manifest.schemaVersion !== share.SCHEMA_VERSION) {
    throw new Error(`manifest round trip failed: ${JSON.stringify(manifest)}`);
  }
  if (manifest.kind !== "lily-workspace-app" || manifest.appId !== "clinical-case-assistant") {
    throw new Error(`workspace app identity must survive export: ${JSON.stringify(manifest)}`);
  }
  if (!manifest.appDataPaths?.includes("cases/") || !manifest.appDataPaths?.includes(".lily-work/app-data/")) {
    throw new Error(`app data paths must be recorded in the pack manifest: ${JSON.stringify(manifest.appDataPaths)}`);
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
  if (fs.existsSync(path.join(dest, "files/README.md")) || fs.existsSync(path.join(dest, "skills/learned-oa-portal/SKILL.md"))) {
    throw new Error("new importer must ignore compatibility mirror entries instead of creating duplicate folders");
  }
  if (fs.readFileSync(path.join(dest, "knowledge/bazi/rules.md"), "utf8") !== "排盘规则") {
    throw new Error("capability file content corrupted on import");
  }
  if (!fs.existsSync(path.join(dest, "cases/P-1.case.json"))) {
    throw new Error("declared case-library data must import with the app");
  }
  if (!fs.existsSync(path.join(dest, ".lily-work/app-data/facts.json"))) {
    throw new Error("declared app data under .lily-work must import with the app");
  }
  if (fs.existsSync(path.join(dest, ".lily-work/cache/scratch.json")) || fs.existsSync(path.join(dest, ".lily-work/tmp.txt"))) {
    throw new Error("undeclared .lily-work scratch/cache files must stay excluded");
  }
  if (!fs.existsSync(path.join(dest, "output/张钦_命理.pdf"))) {
    throw new Error("customer deliverables under output/ must import with the workspace");
  }
  if (fs.existsSync(path.join(dest, ".env")) || fs.existsSync(path.join(dest, "huge-video.mov"))) {
    throw new Error("excluded files must not appear in the imported workspace");
  }

  // Workspace skills are opt-in. The safe default export carries no learned
  // local skills, even when the workspace has them available.
  const noSkillBuf = await share.exportWorkspacePack({
    rootPath: ws,
    name: "算命大师",
    workspaceSkills: [],
    exportedAt: "2026-06-12T00:00:00.000Z",
  });
  const noSkillDest = path.join(tmp, "imported-no-skills");
  const noSkillImport = await share.importWorkspacePack(noSkillBuf, noSkillDest);
  if (noSkillImport.workspaceSkills.length !== 0 || noSkillImport.manifest.workspaceSkills.length !== 0) {
    throw new Error(`workspace skills must be excluded unless explicitly requested: ${JSON.stringify(noSkillImport.manifest.workspaceSkills)}`);
  }

  // If a workspace already has paths that would collide with the compatibility
  // mirror, export must fall back to the unambiguous legacy layout instead of
  // overwriting user files or producing a package that imports differently.
  const conflictWs = path.join(tmp, "conflict-workspace");
  fs.mkdirSync(path.join(conflictWs, "files"), { recursive: true });
  fs.writeFileSync(path.join(conflictWs, "README.md"), "root readme");
  fs.writeFileSync(path.join(conflictWs, "files", "README.md"), "nested readme");
  const conflictBuf = await share.exportWorkspacePack({
    rootPath: conflictWs,
    name: "conflict-workspace",
    exportedAt: "2026-06-12T00:00:00.000Z",
  });
  const conflictZip = await JSZip.loadAsync(conflictBuf);
  if (conflictZip.file(`${share.PACK_META_PREFIX}${share.MANIFEST_NAME}`)) {
    throw new Error("mirror conflicts must fall back to legacy layout, not write ambiguous root-layout entries");
  }
  const conflictDest = path.join(tmp, "conflict-imported");
  await share.importWorkspacePack(conflictBuf, conflictDest);
  if (fs.readFileSync(path.join(conflictDest, "README.md"), "utf8") !== "root readme") {
    throw new Error("legacy fallback must preserve root files");
  }
  if (fs.readFileSync(path.join(conflictDest, "files", "README.md"), "utf8") !== "nested readme") {
    throw new Error("legacy fallback must preserve an actual files/ directory");
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

  const rootEvil = new JSZip();
  rootEvil.file(share.PACK_MANIFEST_ENTRY, JSON.stringify({ kind: "lily-workspace-pack", schemaVersion: 1, requiredSkills: [] }));
  rootEvil.file("../escaped-root.txt", "pwned");
  const rootEvilBuf = await rootEvil.generateAsync({ type: "nodebuffer" });
  await share.importWorkspacePack(rootEvilBuf, path.join(tmp, "root-evil-dest")).catch(() => {});
  if (fs.existsSync(path.join(tmp, "escaped-root.txt"))) throw new Error("root-layout zip-slip wrote outside the target!");

  const compressedBomb = new JSZip();
  compressedBomb.file(share.MANIFEST_NAME, JSON.stringify({
    schemaVersion: share.SCHEMA_VERSION,
    kind: "lily-workspace-pack",
    name: "Compressed bomb",
  }));
  compressedBomb.file("files/large.txt", "x".repeat(2048));
  const compressedBombBuffer = await compressedBomb.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  let rejectedBomb = false;
  try {
    await share.importWorkspacePack(
      compressedBombBuffer,
      path.join(tmp, "compressed-bomb"),
      { maxTotalBytes: 1024 },
    );
  } catch (error) {
    rejectedBomb = error.message === "PACK_UNCOMPRESSED_TOO_LARGE";
  }
  if (!rejectedBomb) throw new Error("compressed package expansion must be bounded before extraction");

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
