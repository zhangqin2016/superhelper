#!/usr/bin/env node

import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { assert, assertEqual, finish } from "./lib/test-assert.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-skill-import-"));

process.resourcesPath = ROOT;
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return tmp;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
      getVersion: () => "0.1.0",
    },
  },
};

const remoteConfigPath = path.join(ROOT, "src/main/remote-config.js");
require.cache[remoteConfigPath] = {
  id: remoteConfigPath,
  filename: remoteConfigPath,
  loaded: true,
  exports: {
    getRemoteEffectiveConfigSync() {
      return null;
    },
  },
};

const skillManager = require(path.join(ROOT, "src/main/skill-manager.js"));
const {
  importWorkspaceSkillSource,
  normalizeWorkspaceSkillId,
} = require(path.join(ROOT, "src/main/workspace-skill-import.js"));
const { exportWorkspacePack } = require(path.join(ROOT, "src/main/workspace-share.js"));

function writeSkillDir(base, id, extra = {}) {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${id}\n\nUse when analyzing ${id}.\n`, "utf8");
  fs.writeFileSync(
    path.join(dir, "skill.manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id,
      name: extra.name || id,
      description: extra.description || "",
      version: extra.version || "0.1.0",
      runtime: extra.runtime || "none",
      ...(extra.extraManifest || {}),
    }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

async function zipDir(sourceDir, zipPath, wrapper = path.basename(sourceDir)) {
  const zip = new JSZip();
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(full, `${rel}/`);
      else zip.file(rel, fs.readFileSync(full));
    }
  }
  walk(sourceDir, `${wrapper}/`);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

function restoreToProject(projectId) {
  return (skill) => skillManager.restoreWorkspaceSkillDir(skill.dir, skill.manifest, {
    enabled: true,
    projectId,
  });
}

assertEqual(normalizeWorkspaceSkillId("demo"), "learned-demo", "plain ids import under learned namespace");
assertEqual(normalizeWorkspaceSkillId("learned-demo"), "learned-demo", "learned ids stay stable");
assertEqual(normalizeWorkspaceSkillId("Bad_ID"), "", "invalid ids are rejected");

const srcRoot = path.join(tmp, "src");
const dirSkill = writeSkillDir(srcRoot, "customer-oa", {
  name: "Customer OA",
  extraManifest: { permissions: { filesystem: "read" } },
});
const zipPath = path.join(tmp, "customer-oa.zip");
await zipDir(dirSkill, zipPath);

const zipImport = await importWorkspaceSkillSource(zipPath, { restore: restoreToProject("project-a") });
assert(zipImport.ok, `zip import should succeed: ${JSON.stringify(zipImport)}`);
assertEqual(zipImport.id, "learned-customer-oa", "zip import normalizes the installed id");

const installedDir = skillManager.installedSkillDir("learned-customer-oa");
const installedManifest = JSON.parse(fs.readFileSync(path.join(installedDir, "skill.manifest.json"), "utf8"));
assertEqual(installedManifest.id, "learned-customer-oa", "installed manifest is rewritten to the normalized id");
assertEqual(installedManifest.workspaceOnly, true, "imported skill is workspace-only");
assertEqual(installedManifest.origin, "workspace", "imported skill is marked as workspace origin");
assert(fs.existsSync(path.join(installedDir, "SKILL.md")), "SKILL.md is installed");

const state = skillManager.loadSkillsState();
const entry = state.skills["learned-customer-oa"];
assert(entry?.enabledProjectIds?.includes("project-a"), "import binds the skill to the selected workspace");
assertEqual(entry.source, "learned", "imported workspace skill uses the learned source");
assert(!state.skills["customer-oa"], "import must not install the raw id globally");

const dirImport = await importWorkspaceSkillSource(dirSkill, { restore: restoreToProject("project-b") });
assert(dirImport.ok, `directory import should succeed: ${JSON.stringify(dirImport)}`);
assert(
  skillManager.loadSkillsState().skills["learned-customer-oa"].enabledProjectIds.includes("project-b"),
  "directory import can bind the same skill to another workspace",
);

const packWorkspace = path.join(tmp, "pack-workspace");
fs.mkdirSync(packWorkspace, { recursive: true });
fs.writeFileSync(path.join(packWorkspace, "README.md"), "workspace with skill", "utf8");
const packBuf = await exportWorkspacePack({
  rootPath: packWorkspace,
  name: "skill-carrying-workspace",
  workspaceSkills: [{ id: "customer-oa", dir: dirSkill, enabled: true }],
  exportedAt: "2026-07-05T00:00:00.000Z",
});
const packPath = path.join(tmp, "skill-carrying-workspace.lilyspace.zip");
fs.writeFileSync(packPath, packBuf);
const packImport = await importWorkspaceSkillSource(packPath, { restore: restoreToProject("project-c") });
assert(packImport.ok, `workspace pack skill import should succeed: ${JSON.stringify(packImport)}`);
assert(packImport.ids.includes("learned-customer-oa"), "workspace pack import restores embedded skills");
assert(
  skillManager.loadSkillsState().skills["learned-customer-oa"].enabledProjectIds.includes("project-c"),
  "workspace pack import binds embedded skills to the selected workspace",
);

const protectedSkill = writeSkillDir(srcRoot, "lily-image-generation");
const protectedResult = await importWorkspaceSkillSource(protectedSkill, { restore: restoreToProject("project-a") });
assertEqual(protectedResult.ok, false, "protected bundled skills cannot be imported over platform skills");
assertEqual(protectedResult.error, "BUNDLED_PROTECTED", "protected import reports the right error");

const nodeModulesSkill = writeSkillDir(srcRoot, "bad-deps");
fs.mkdirSync(path.join(nodeModulesSkill, "node_modules"), { recursive: true });
const nodeModulesResult = await importWorkspaceSkillSource(nodeModulesSkill, { restore: restoreToProject("project-a") });
assertEqual(nodeModulesResult.ok, false, "node_modules is rejected from workspace skill imports");
assertEqual(nodeModulesResult.error, "INVALID_MANIFEST", "node_modules rejection is a manifest error");

const existingSkillMd = fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8");
const corruptSameId = path.join(srcRoot, "corrupt-same-id");
fs.mkdirSync(corruptSameId, { recursive: true });
fs.writeFileSync(path.join(corruptSameId, "SKILL.md"), "# corrupt\n", "utf8");
fs.writeFileSync(
  path.join(corruptSameId, "skill.manifest.json"),
  JSON.stringify({ schemaVersion: 1, id: "different-id", version: "9.9.9" }),
  "utf8",
);
const failedRestore = skillManager.restoreWorkspaceSkillDir(corruptSameId, {
  id: "learned-customer-oa",
  version: "9.9.9",
}, { enabled: true, projectId: "project-a" });
assertEqual(failedRestore, null, "manifest mismatch restore fails");
assertEqual(
  fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8"),
  existingSkillMd,
  "failed restore must preserve the previously installed workspace skill",
);

const preload = fs.readFileSync(path.join(ROOT, "src/preload.js"), "utf8");
assert(preload.includes("importWorkspaceSkill"), "preload exposes workspace skill import");

const ipcSessions = fs.readFileSync(path.join(ROOT, "src/main/ipc-sessions.js"), "utf8");
assert(ipcSessions.includes('ipcMain.handle("skills:import-workspace"'), "main registers workspace skill import IPC");
assert(ipcSessions.includes("importWorkspaceSkillSource"), "IPC imports through the hardened workspace skill importer");
assert(ipcSessions.includes("anyRunnerBusy"), "workspace skill import is blocked while a turn is running");
assert(ipcSessions.includes("syncInheritedSessionGuides"), "workspace skill import refreshes inherited session guides");

const skillSettings = fs.readFileSync(path.join(ROOT, "src/renderer/modules/skill-settings.js"), "utf8");
assert(skillSettings.includes("skillsImportWorkspaceBtn"), "skill settings wires the import button");
assert(skillSettings.includes("importWorkspaceSkill"), "skill settings calls the import API");

const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
assert(html.includes('id="skillsImportWorkspaceBtn"'), "settings UI includes a workspace skill import button");

for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, "src/renderer/i18n/locales", `${locale}.json`), "utf8"));
  for (const key of [
    "settings.skillsImportWorkspace",
    "toast.skillsImportBusy",
    "toast.skillsImportedWorkspace",
    "toast.skillsImportFailed",
    "errors.NO_PROJECT",
  ]) {
    assert(messages[key], `${locale} missing ${key}`);
  }
}

finish("test-workspace-skill-import", 47);
