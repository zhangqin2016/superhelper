#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-pack-installer-"));
const userData = path.join(tmp, "user-data");
process.env.LILY_USER_DATA_DIR = userData;
const runtimePackRoot = path.join(tmp, "external-runtime-root");
process.env.LILY_RUNTIME_PACK_ROOT = runtimePackRoot;
const bundledRoot = path.join(tmp, "bundled-runtime-packs");
process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS = bundledRoot;
const bundledWeb = path.join(bundledRoot, "web-automation");
fs.mkdirSync(path.join(bundledWeb, "node_modules"), { recursive: true });
fs.mkdirSync(path.join(bundledWeb, "browsers"), { recursive: true });

const zip = new JSZip();
zip.file("module/__init__.py", "OK = True\n");
const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");

const server = http.createServer((req, res) => {
  if (req.url === "/pack.zip") {
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": zipBuffer.length,
    });
    res.end(zipBuffer);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const serviceClient = require("../src/main/service-client.js");
  serviceClient.runtimePackArtifact = async (packId, platform) => ({
    ok: true,
    json: {
      artifact: {
        url: `http://127.0.0.1:${server.address().port}/pack.zip`,
        sha256,
        version: "1.2.3",
        format: "zip",
        platform,
        packId,
      },
    },
  });

  const installer = require("../src/main/runtime-pack-installer.js");
  assert.equal(
    installer.archiveExtensionForArtifact({ format: "zip", url: "https://cdn.example.com/libreoffice.zip" }),
    ".zip",
    "zip runtime-pack temp files should keep a .zip extension for extractor compatibility",
  );
  assert.equal(
    installer.archiveExtensionForArtifact({ format: "tar.gz", url: "https://cdn.example.com/pack.tar.gz" }),
    ".tar.gz",
    "tar.gz runtime-pack temp files should keep a tar.gz extension for diagnostics and extraction",
  );
  const catalog = installer.listRuntimePacks();
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.categories.map((category) => category.id), ["document", "image", "browser", "media"]);
  assert.equal(catalog.packs.some((pack) => pack.id === "pro-pdf" && pack.category === "document"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "large-document" && pack.category === "document"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "libreoffice" && pack.category === "document"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "pandoc" && pack.category === "document"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "pillow" && pack.category === "image"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "opencv" && pack.category === "image"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "rapidocr" && pack.category === "image"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "rembg" && pack.category === "image"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "web-automation" && pack.category === "browser"), true);
  assert.equal(catalog.packs.some((pack) => pack.id === "ffmpeg" && pack.category === "media"), true);
  const bundledWebPack = catalog.packs.find((pack) => pack.id === "web-automation");
  assert.equal(bundledWebPack?.installed, true);
  assert.equal(bundledWebPack?.source, "bundled");
  assert.equal(bundledWebPack?.locationKind, "bundled", "bundled pack should report a stable location kind");
  assert.equal(bundledWebPack?.readOnly, true);
  assert.equal(bundledWebPack?.path, bundledWeb);
  assert(installer.installedRuntimePackIds().has("web-automation"), "bundled pack should count as installed");
  const legacyExtraDir = path.join(userData, "runtime-packs", "legacy-extra-pack");
  fs.mkdirSync(legacyExtraDir, { recursive: true });
  fs.writeFileSync(
    path.join(userData, "runtime-packs.json"),
    JSON.stringify({
      schemaVersion: 1,
      installed: {
        "legacy-extra-pack": { source: "artifact", version: "0.1.0", installedAt: "2026-01-01T00:00:00.000Z" },
      },
    }),
    "utf8",
  );
  assert(installer.installedRuntimePackIds().has("legacy-extra-pack"), "legacy userData pack should count as installed");
  const legacyListed = installer.listRuntimePacks().packs.find((pack) => pack.id === "legacy-extra-pack");
  assert.equal(legacyListed?.installed, true, "legacy userData pack should be visible in settings list");
  assert.equal(legacyListed?.path, legacyExtraDir, "legacy userData pack should report its actual path");
  assert.equal(legacyListed?.locationKind, "legacy", "legacy userData pack should report its source location");
  const baseProvided = installer.baseProvidedRuntimePackMap();
  for (const id of ["libreoffice", "pillow", "opencv", "rapidocr"]) {
    if (!baseProvided.has(id)) continue;
    const pack = catalog.packs.find((item) => item.id === id);
    assert.equal(pack?.installed, true, `${id} from base runtime should be listed as installed`);
    assert.equal(pack?.source, "base", `${id} from base runtime should report source=base`);
    assert.equal(pack?.readOnly, true, `${id} from base runtime should be read-only`);
    assert(installer.installedRuntimePackIds().has(id), `${id} from base runtime should satisfy dependency requirements`);
  }
  const available = await installer.checkRuntimePackAvailability(["rembg", "web-automation", "not-a-pack"]);
  assert.equal(available.ok, true);
  assert.equal(available.packs.find((pack) => pack.id === "rembg")?.available, true, "available artifact should be reported before install");
  assert.equal(available.packs.find((pack) => pack.id === "web-automation")?.installed, true, "bundled pack should not hit server availability");
  assert.equal(available.packs.find((pack) => pack.id === "not-a-pack")?.error, "INVALID_RUNTIME_PACK");
  const originalRuntimePackArtifact = serviceClient.runtimePackArtifact;
  serviceClient.runtimePackArtifact = async () => ({ ok: true, json: { artifact: null } });
  const unavailable = await installer.checkRuntimePackAvailability(["ffmpeg"]);
  assert.equal(unavailable.packs[0].available, false);
  assert.equal(unavailable.packs[0].error, "NO_RUNTIME_PACK_ARTIFACT");
  serviceClient.runtimePackArtifact = async () => ({ ok: false, error: "SERVICE_REQUEST_FAILED", detail: "fetch failed" });
  const serviceFailed = await installer.checkRuntimePackAvailability(["ffmpeg"]);
  assert.equal(serviceFailed.packs[0].available, null, "service failures should not be reported as missing artifacts");
  assert.equal(serviceFailed.packs[0].error, "SERVICE_REQUEST_FAILED");
  serviceClient.runtimePackArtifact = originalRuntimePackArtifact;

  const bundledInstall = await installer.installRuntimePack("web-automation");
  assert.equal(bundledInstall.ok, true);
  assert.equal(bundledInstall.skipped, true);
  assert.equal(bundledInstall.source, "bundled");

  const bundledUninstall = installer.uninstallRuntimePack("web-automation");
  assert.equal(bundledUninstall.ok, false);
  assert.equal(bundledUninstall.error, "BUNDLED_RUNTIME_PACK_READ_ONLY");

  const progressEvents = [];
  const installed = await installer.installRuntimePack("pro-pdf");
  assert.equal(installed.ok, true, `install failed: ${JSON.stringify(installed)}`);
  assert.equal(installed.version, "1.2.3");
  assert(
    fs.existsSync(path.join(runtimePackRoot, "runtime-packs", "pro-pdf", "module", "__init__.py")),
    "pack contents should be installed under the selected runtime-pack root",
  );
  assert(!fs.existsSync(path.join(userData, "runtime-packs", "pro-pdf")), "new installs must not copy pack contents into userData");

  const installedWithProgress = await installer.installRuntimePack("progress-pack", {
    onProgress: (event) => progressEvents.push(event),
  });
  assert.equal(installedWithProgress.ok, true, `progress install failed: ${JSON.stringify(installedWithProgress)}`);
  const progress = progressEvents.map((event) => event.phase);
  assert(progress.includes("resolving"), "install should report resolving progress");
  assert(progress.includes("downloading"), "install should report downloading progress");
  assert(progress.includes("verifying"), "install should report verifying progress");
  assert(progress.includes("extracting"), "install should report extracting progress");
  assert(progress.includes("installed"), "install should report installed progress");
  assert(
    progressEvents.some((event) => event.phase === "extracting" && event.backend),
    "extracting progress should include the active extractor backend",
  );

  const state = JSON.parse(fs.readFileSync(path.join(runtimePackRoot, "runtime-packs.json"), "utf8"));
  assert.equal(state.installed["pro-pdf"].source, "artifact");
  assert.equal(state.installed["pro-pdf"].format, "zip");
  assert(installer.installedRuntimePackIds().has("pro-pdf"), "installed id should be visible");
  assert.equal(
    installer.listRuntimePacks().packs.find((pack) => pack.id === "pro-pdf")?.locationKind,
    "selected",
    "new installs should report the current dependency location",
  );

  const skipped = await installer.installRuntimePack("pro-pdf");
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);

  serviceClient.runtimePackArtifact = async (packId, platform) => ({
    ok: true,
    json: {
      artifact: {
        url: `http://127.0.0.1:${server.address().port}/pack.zip`,
        sha256,
        version: "2.0.0",
        format: "zip",
        platform,
        packId,
      },
    },
  });
  const forced = await installer.installRuntimePack("pro-pdf", { force: true });
  assert.equal(forced.ok, true, `forced reinstall failed: ${JSON.stringify(forced)}`);
  assert.equal(forced.skipped, undefined, "force install must not skip an existing pack");
  assert.equal(forced.repaired, true, "force install should report repaired=true");
  assert.equal(forced.version, "2.0.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimePackRoot, "runtime-packs.json"), "utf8")).installed["pro-pdf"].version, "2.0.0");

  serviceClient.runtimePackArtifact = async (packId, platform) => ({
    ok: true,
    json: {
      artifact: {
        url: `http://127.0.0.1:${server.address().port}/pack.zip`,
        sha256,
        version: "3.0.0",
        format: "zip",
        platform,
        packId,
      },
    },
  });
  const repaired = await installer.repairInstalledRuntimePacks({
    ids: ["pro-pdf"],
    checkHealth: async () => ({ ok: false, status: "failed", error: "BROKEN_OLD_PACK" }),
  });
  assert.equal(repaired.ok, true, `repair failed: ${JSON.stringify(repaired)}`);
  assert.equal(repaired.results[0].repaired, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimePackRoot, "runtime-packs.json"), "utf8")).installed["pro-pdf"].version, "3.0.0");

  const badPackDir = path.join(runtimePackRoot, "runtime-packs", "bad-pack");
  fs.rmSync(badPackDir, { recursive: true, force: true });
  fs.mkdirSync(badPackDir, { recursive: true });
  fs.writeFileSync(path.join(badPackDir, "keep.txt"), "existing", "utf8");
  serviceClient.runtimePackArtifact = async () => ({
    ok: true,
    json: {
      artifact: {
        url: `http://127.0.0.1:${server.address().port}/pack.zip`,
        sha256: "0".repeat(64),
        version: "9.9.9",
        format: "zip",
      },
    },
  });
  const bad = await installer.installRuntimePack("bad-pack");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "CHECKSUM_MISMATCH");
  assert.equal(
    fs.readFileSync(path.join(badPackDir, "keep.txt"), "utf8"),
    "existing",
    "failed install must preserve an existing target dir",
  );

  const removed = installer.uninstallRuntimePack("pro-pdf");
  assert.equal(removed.ok, true);
  assert(!fs.existsSync(path.join(runtimePackRoot, "runtime-packs", "pro-pdf")), "uninstall must remove the pack dir");
  assert(!installer.installedRuntimePackIds().has("pro-pdf"), "uninstalled id should not be visible");

  fs.mkdirSync(path.join(runtimePackRoot, "runtime-packs"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimePackRoot, "runtime-packs.json"),
    JSON.stringify({ schemaVersion: 1, installed: { ghost: { source: "artifact", version: "9.9.9" } } }),
    "utf8",
  );
  assert(!installer.installedRuntimePackIds().has("ghost"), "missing artifact dir must not be treated as installed");

  const installerSource = fs.readFileSync(path.join(process.cwd(), "src/main/runtime-pack-installer.js"), "utf8");
  assert(
    !installerSource.includes('execFileSync("powershell"'),
    "Windows extraction must not block the main process with sync Expand-Archive",
  );
  assert(installerSource.includes("spawn(candidate.command"), "runtime-pack extraction should use async spawn");
  assert(installerSource.includes('require("7zip-bin")'), "runtime-pack extraction should prefer bundled 7zip-bin");
  assert(installerSource.includes(".asar.unpacked"), "bundled extractor paths should resolve out of Electron asar");
  assert(
    installerSource.includes("const cacheDir = packsRoot()"),
    "runtime-pack downloads and extraction staging should use the selected dependency root, not userData",
  );
  assert(
    !installerSource.includes('const cacheDir = userDataPath("runtime-packs")'),
    "runtime-pack downloads must not keep large temporary archives under userData after a custom root is selected",
  );
  assert(
    installerSource.includes("replacePackDirectory(stagingPath, target)"),
    "runtime-pack install should atomically replace the target after staging extraction",
  );
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("runtime-pack-installer: ok");
