#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import module from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/test-assert.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-doc-packs-"));

// Mock electron so userDataPath (config.js → app.getPath) writes into a temp dir.
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

const packs = require(path.join(ROOT, "src/main/document-packs.js"));
const { resolveVenvPython } = require(path.join(ROOT, "src/main/runtime-python.js"));

// --- Fresh-state + listing -------------------------------------------------

const proPdf = packs.listPacks().find((p) => p.id === "pro-pdf");
assert(proPdf, "pro-pdf pack must be listed");
assert(proPdf.installed === false, "pro-pdf must start uninstalled on fresh state");
assert(proPdf.label?.["zh-CN"] && proPdf.sizeEstimate, "pack must carry label + size estimate for the UI");

// --- State round-trip ------------------------------------------------------

packs.markPackInstalled("pro-pdf", { source: "artifact", version: "1.0.0" });
const marked = packs.listPacks().find((p) => p.id === "pro-pdf");
assert(marked.installed === true && marked.source === "artifact", "marked pack should read installed w/ source");
packs.markPackRemoved("pro-pdf");
assert(packs.listPacks().find((p) => p.id === "pro-pdf").installed === false, "removed pack should read uninstalled");

// --- Failure modes fail loud ----------------------------------------------

let rejectedUnknown = false;
try {
  await packs.installPack("does-not-exist");
} catch (err) {
  rejectedUnknown = /UNKNOWN_PACK/.test(err.message);
}
assert(rejectedUnknown, "installing an unknown pack must reject with UNKNOWN_PACK");

let rejectedEmpty = false;
try {
  await packs.installPackRequirements({ requirements: [] });
} catch (err) {
  rejectedEmpty = /NO_REQUIREMENTS/.test(err.message);
}
assert(rejectedEmpty, "empty requirements must reject with NO_REQUIREMENTS");

// --- Artifact install path (the China-friendly Qiniu flow) -----------------
// Build a tiny tarball that stands in for the pro-pdf artifact — it contains a
// `docling` stub so the pack's real probe (`import docling`) succeeds via the
// pack dir on PYTHONPATH. Served over localhost http; the server-resolved URL
// is injected, exactly as the real service-client would supply it.

if (!resolveVenvPython()) {
  console.log("test-document-packs: (artifact flow SKIPPED — no bundled runtime)");
} else {
  const stageDir = path.join(tmp, "stage");
  fs.mkdirSync(path.join(stageDir, "docling"), { recursive: true });
  fs.writeFileSync(path.join(stageDir, "docling", "__init__.py"), "VERSION = 'stub'\n");
  const tarPath = path.join(tmp, "pro-pdf.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", stageDir, "."]);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/gzip" });
    fs.createReadStream(tarPath).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/pro-pdf.tar.gz`;

  try {
    // A wrong sha256 must be rejected and leave nothing behind — a corrupt or
    // tampered download must never be put on the import path.
    let shaRejected = false;
    try {
      await packs.installPack("pro-pdf", { resolveArtifact: async () => ({ url, sha256: "0".repeat(64) }) });
    } catch (err) {
      shaRejected = /SHA256_MISMATCH/.test(err.message);
    }
    assert(shaRejected, "sha256 mismatch must reject");
    assert(packs.verifyPack("pro-pdf") === false, "failed install must not leave an importable pack");

    // Correct sha256: full path — download, verify, extract, probe, record.
    const result = await packs.installPack("pro-pdf", {
      resolveArtifact: async () => ({ url, sha256, version: "1.0.0" }),
    });
    assert(result.source === "artifact", `expected artifact source, got ${result.source}`);
    assert(packs.verifyPack("pro-pdf") === true, "installed artifact pack must verify (docling importable)");
    assert(
      packs.getDocumentPackPythonPaths().some((p) => p.endsWith(path.join("document-packs", "pro-pdf"))),
      "installed artifact pack dir must be on the PYTHONPATH list",
    );
    const listed = packs.listPacks().find((p) => p.id === "pro-pdf");
    assert(listed.installed && listed.source === "artifact" && listed.version === "1.0.0", "listing reflects artifact install");

    // Uninstall removes the dir and the pack is no longer importable.
    await packs.uninstallPack("pro-pdf");
    assert(packs.verifyPack("pro-pdf") === false, "uninstalled pack must not verify");
    assert(packs.getDocumentPackPythonPaths().length === 0, "uninstalled pack must drop from PYTHONPATH list");
  } finally {
    server.close();
  }
  console.log("test-document-packs: artifact flow ok (download → sha256 → extract → probe → uninstall)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-document-packs: ok");
