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
  const installed = await installer.installRuntimePack("pro-pdf");
  assert.equal(installed.ok, true, `install failed: ${JSON.stringify(installed)}`);
  assert.equal(installed.version, "1.2.3");
  assert(fs.existsSync(path.join(userData, "runtime-packs", "pro-pdf", "module", "__init__.py")), "pack contents missing");

  const state = JSON.parse(fs.readFileSync(path.join(userData, "runtime-packs.json"), "utf8"));
  assert.equal(state.installed["pro-pdf"].source, "artifact");
  assert.equal(state.installed["pro-pdf"].format, "zip");
  assert(installer.installedRuntimePackIds().has("pro-pdf"), "installed id should be visible");

  const skipped = await installer.installRuntimePack("pro-pdf");
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);

  fs.rmSync(path.join(userData, "runtime-packs", "bad-pack"), { recursive: true, force: true });
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
  assert(!fs.existsSync(path.join(userData, "runtime-packs", "bad-pack")), "failed install must not leave target dir");
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("runtime-pack-installer: ok");
