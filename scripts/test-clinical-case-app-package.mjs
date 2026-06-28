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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-clinical-case-app-"));

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build-clinical-case-app.mjs"),
      "--out", tmpDir,
      "--version", "test-clinical-case",
      "--exported-at", "2026-06-28T00:00:00.000Z",
    ],
    { cwd: root, stdio: "pipe" },
  );

  const artifact = path.join(tmpDir, "clinical-case-assistant-test-clinical-case.lilyspace.zip");
  assert(fs.existsSync(artifact), "clinical case app package is built");

  const buffer = fs.readFileSync(artifact);
  const inspected = await inspectWorkspaceAppArtifact(buffer);
  assert(inspected.ok, `workspace app artifact passes server inspection: ${inspected.code || ""}`);
  assert(inspected.manifest.kind === "lily-workspace-app", "manifest uses workspace app kind");

  const zip = await JSZip.loadAsync(buffer);
  const rawManifest = JSON.parse(await zip.file("lily-workspace.json").async("string"));
  const appManifest = JSON.parse(await zip.file("files/lily-app.json").async("string"));
  const entries = Object.keys(zip.files);

  assert(rawManifest.appId === "clinical-case-assistant", "raw manifest has stable app id");
  assert(rawManifest.appDataPaths?.includes("cases/"), "raw manifest declares the durable case-library path");
  assert(appManifest.export?.dataPaths?.includes("cases/"), "app manifest declares cases/ as exportable app data");
  assert(
    !entries.some((name) => name.startsWith("files/cases/")),
    "official template package must not ship patient case data",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("clinical-case-app-package: ok");
