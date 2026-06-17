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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mail-app-"));

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build-mail-workspace-app.mjs"),
      "--out",
      tmpDir,
      "--version",
      "test-mail-app",
      "--exported-at",
      "2026-06-17T00:00:00.000Z",
    ],
    { cwd: root, stdio: "pipe" },
  );

  const artifact = path.join(tmpDir, "mail-assistant-test-mail-app.lilyspace.zip");
  assert(fs.existsSync(artifact), "mail assistant app package is built");

  const buffer = fs.readFileSync(artifact);
  const inspected = await inspectWorkspaceAppArtifact(buffer);
  assert(inspected.ok, `workspace app artifact passes server inspection: ${inspected.code || ""}`);
  assert(inspected.manifest.kind === "lily-workspace-app", "manifest uses workspace app kind");
  assert(
    inspected.manifest.requiredSkills?.includes("lily-mail-assistant"),
    "manifest requires lily-mail-assistant skill",
  );

  const zip = await JSZip.loadAsync(buffer);
  const rawManifest = JSON.parse(await zip.file("lily-workspace.json").async("string"));
  const readme = await zip.file("files/README.md").async("string");
  const agentsMd = await zip.file("files/AGENTS.md").async("string");
  const playbook = JSON.parse(await zip.file("files/mail-playbook.example.json").async("string"));

  assert(rawManifest.appId === "mail-assistant", "raw manifest has stable app id");
  assert(readme.includes("Gmail"), "README documents Gmail provider");
  assert(readme.includes("Outlook / Microsoft 365"), "README documents Microsoft 365 provider");
  assert(readme.includes("IMAP/SMTP"), "README documents IMAP/SMTP provider");
  assert(readme.includes("不要把邮箱密码"), "README forbids secrets in chat");
  assert(readme.includes("必须先展示影响范围"), "README requires confirmation for mailbox changes");
  assert(agentsMd.includes("Do not send until the user reviews"), "AGENTS enforces draft-before-send");
  assert(playbook.actions.some((action) => action.id === "mail.send" && action.confirmation === "explicit"), "playbook makes send explicit-confirmation");
  assert(playbook.credentialPolicy.chatSecrets === false, "playbook forbids chat secrets");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("PASS: test-mail-workspace-app-package");
