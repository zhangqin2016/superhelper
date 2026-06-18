#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { assert } from "./lib/test-assert.mjs";
import { inspectWorkspaceAppArtifact } from "../server/src/services/workspace-apps.js";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-web-learning-app-"));

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build-web-system-learning-workspace-app.mjs"),
      "--out",
      tmpDir,
      "--version",
      "test-web-learning-app",
      "--exported-at",
      "2026-06-17T00:00:00.000Z",
    ],
    { cwd: root, stdio: "pipe" },
  );

  const artifact = path.join(tmpDir, "web-system-learning-test-web-learning-app.lilyspace.zip");
  assert(fs.existsSync(artifact), "web system learning app package is built");

  const buffer = fs.readFileSync(artifact);
  const inspected = await inspectWorkspaceAppArtifact(buffer);
  assert(inspected.ok, `workspace app artifact passes server inspection: ${inspected.code || ""}`);
  assert(inspected.manifest.kind === "lily-workspace-app", "manifest uses workspace app kind");
  assert(
    inspected.manifest.requiredSkills?.includes("lily-web-system-learning"),
    "manifest requires lily-web-system-learning skill",
  );

  const zip = await JSZip.loadAsync(buffer);
  const rawManifest = JSON.parse(await zip.file("lily-workspace.json").async("string"));
  const readme = await zip.file("files/README.md").async("string");
  const agentsMd = await zip.file("files/AGENTS.md").async("string");
  const checklist = await zip.file("files/web-system-learning-checklist.md").async("string");
  const playbook = JSON.parse(await zip.file("files/web-system-learning-playbook.template.json").async("string"));

  assert(rawManifest.appId === "web-system-learning", "raw manifest has stable app id");
  assert(rawManifest.folderName === "web-system-learning", "raw manifest has stable English folder name");
  assert(readme.includes("OA、ERP、CRM"), "README explains target systems");
  assert(readme.includes("用户在浏览器里自己完成登录"), "README keeps credentials out of chat");
  assert(readme.includes("capability-map.json") && readme.includes("api-map.json") && readme.includes("health.json"), "README documents the capability package");
  assert(readme.includes("API 优先 / 浏览器兜底"), "README explains the fast execution path");
  assert(readme.includes("提交、审批、删除、上传、付款、通知"), "README requires confirmation for high-risk actions");
  assert(agentsMd.includes("Generated skills are drafts until the user reviews and enables them"), "AGENTS enforces review-before-enable");
  assert(agentsMd.includes("route through the generated capability map first"), "AGENTS enforces capability-first execution");
  assert(checklist.includes("域名白名单"), "checklist requires domain allowlist");
  assert(checklist.includes("capability-map.json") && checklist.includes("api-map.json") && checklist.includes("health.json"), "checklist requires capability/API/health artifacts");
  assert(playbook.connector === "web-system", "playbook uses web-system connector");
  assert(playbook.actions.some((action) => action.risk === "prepare" && action.confirmation === "review"), "playbook models prepare actions with review");
  assert(playbook.credentialPolicy.chatSecrets === false, "playbook forbids chat secrets");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("PASS: test-web-system-learning-workspace-app-package");
