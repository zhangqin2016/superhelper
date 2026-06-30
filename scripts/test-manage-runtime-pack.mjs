#!/usr/bin/env node
//
// Tests the agent-facing pack manager (resources/skills-catalog/lily-runtime-packs/
// scripts/manage_runtime_pack.py) end to end, offline: a localhost server stands in for
// our API + Qiniu CDN. Verifies resolve → download → sha256 → extract → state,
// and that the on-disk layout matches what the main process (runtime-packs.js)
// reads — pack dir + runtime-packs.json.
//
// NOTE: the python script calls back into the localhost servers over HTTP, so we
// MUST drive it with async execFile — a sync execFileSync would block node's
// event loop and the servers could never answer (the script would just time out).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const pexec = promisify(execFile);
const require = createRequire(import.meta.url);
const { resolveVenvPython } = require("../src/main/runtime-python.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "resources", "skills-catalog", "lily-runtime-packs", "scripts", "manage_runtime_pack.py");

assert(fs.existsSync(SCRIPT), "manage_runtime_pack.py must exist in the skill");

const python = resolveVenvPython();
if (!python) {
  console.log("test-manage-runtime-pack: ok (SKIPPED — no bundled runtime)");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-managepack-"));
const userData = path.join(tmp, "userData");
fs.mkdirSync(userData, { recursive: true });
const bundledRoot = path.join(tmp, "bundled-runtime-packs");
const bundledWeb = path.join(bundledRoot, "web-automation");
fs.mkdirSync(bundledWeb, { recursive: true });

// Stub artifacts containing a `docling` package and a LibreOffice-style zip
// (sync packing is fine — no server is listening yet).
const stage = path.join(tmp, "stage");
fs.mkdirSync(path.join(stage, "docling"), { recursive: true });
fs.writeFileSync(path.join(stage, "docling", "__init__.py"), "OK = True\n");
const tarPath = path.join(tmp, "pro-pdf.tar.gz");
execFileSync("tar", ["-czf", tarPath, "-C", stage, "."]);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");

const loStage = path.join(tmp, "lo-stage");
fs.mkdirSync(path.join(loStage, "program"), { recursive: true });
fs.writeFileSync(path.join(loStage, "program", "soffice.exe"), "fake exe\n");
const zipPath = path.join(tmp, "libreoffice.zip");
execFileSync(python, [
  "-c",
  "import pathlib, sys, zipfile\nroot=pathlib.Path(sys.argv[1]); out=sys.argv[2]\nwith zipfile.ZipFile(out, 'w') as z:\n    for p in root.rglob('*'):\n        if p.is_file(): z.write(p, p.relative_to(root).as_posix())\n",
  loStage,
  zipPath,
]);
const zipSha256 = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");

function makeServer(advertisedSha) {
  return http.createServer((req, res) => {
    if (req.url.startsWith("/api/runtime-packs/artifact")) {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const pack = requestUrl.searchParams.get("pack");
      const base = `http://127.0.0.1:${res.socket.localPort}`;
      res.writeHead(200, { "content-type": "application/json" });
      if (pack === "libreoffice") {
        res.end(
          JSON.stringify({
            artifact: {
              url: `${base}/libreoffice.zip`,
              sha256: advertisedSha === sha256 ? zipSha256 : advertisedSha,
              version: "25.8.7",
              sizeBytes: fs.statSync(zipPath).size,
              format: "zip",
            },
          }),
        );
      } else {
        res.end(JSON.stringify({ artifact: { url: `${base}/pack.tar.gz`, sha256: advertisedSha, version: "9.9.9", sizeBytes: fs.statSync(tarPath).size } }));
      }
    } else if (req.url.startsWith("/pack.tar.gz")) {
      res.writeHead(200, { "content-type": "application/gzip" });
      fs.createReadStream(tarPath).pipe(res);
    } else if (req.url.startsWith("/libreoffice.zip")) {
      res.writeHead(200, { "content-type": "application/zip" });
      fs.createReadStream(zipPath).pipe(res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

const server = makeServer(sha256);
const badServer = makeServer("0".repeat(64)); // advertises a wrong sha256
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await new Promise((r) => badServer.listen(0, "127.0.0.1", r));

const baseEnv = {
  ...process.env,
  LILY_USER_DATA_DIR: userData,
  LILY_BUNDLED_RUNTIME_PACK_ROOTS: bundledRoot,
  no_proxy: "127.0.0.1,localhost",
  NO_PROXY: "127.0.0.1,localhost",
};
const okEnv = { ...baseEnv, LILY_SERVICE_API_BASE_URL: `http://127.0.0.1:${server.address().port}` };
const badEnv = { ...baseEnv, LILY_SERVICE_API_BASE_URL: `http://127.0.0.1:${badServer.address().port}` };
// The script prints one JSON line and exits non-zero on failure; pexec rejects
// on non-zero, but the JSON is still on err.stdout — parse either way.
const run = async (args, env = okEnv) => {
  try {
    return JSON.parse((await pexec(python, [SCRIPT, ...args], { env })).stdout);
  } catch (err) {
    if (err && typeof err.stdout === "string" && err.stdout.trim()) return JSON.parse(err.stdout);
    throw err;
  }
};

const packDir = path.join(userData, "runtime-packs", "pro-pdf");

try {
  // Fresh: pro-pdf listed, not installed.
  const listed = await run(["list"]);
  assert(listed.ok && listed.packs.some((p) => p.id === "pro-pdf" && !p.installed), `unexpected list: ${JSON.stringify(listed)}`);
  assert(listed.packs.some((p) => p.id === "libreoffice" && !p.installed), `libreoffice missing from list: ${JSON.stringify(listed)}`);
  for (const id of ["pillow", "opencv", "rapidocr", "rembg"]) {
    assert(listed.packs.some((p) => p.id === id && !p.installed), `${id} missing from list: ${JSON.stringify(listed)}`);
  }
  assert(
    listed.packs.some((p) => p.id === "web-automation" && p.installed && p.source === "bundled"),
    `bundled web runtime should be listed as installed: ${JSON.stringify(listed)}`,
  );
  const bundledStatus = await run(["status", "web-automation"]);
  assert(
    bundledStatus.installed === true && bundledStatus.source === "bundled" && bundledStatus.path === bundledWeb,
    `bundled status mismatch: ${JSON.stringify(bundledStatus)}`,
  );
  const bundledInstall = await run(["install", "web-automation"]);
  assert(
    bundledInstall.ok && bundledInstall.skipped && bundledInstall.source === "bundled",
    `bundled install should skip: ${JSON.stringify(bundledInstall)}`,
  );
  const bundledRemove = await run(["uninstall", "web-automation"]);
  assert(
    !bundledRemove.ok && bundledRemove.error === "BUNDLED_RUNTIME_PACK_READ_ONLY",
    `bundled uninstall should be blocked: ${JSON.stringify(bundledRemove)}`,
  );

  // Install: resolves the (fake) server, downloads, verifies sha256, extracts.
  const installed = await run(["install", "pro-pdf"]);
  assert(installed.ok && installed.installed === "pro-pdf", `install failed: ${JSON.stringify(installed)}`);

  // On-disk contract the main process relies on: the extracted dir works as a
  // PYTHONPATH entry (this probe hits no server, so sync is fine here).
  assert(fs.existsSync(path.join(packDir, "docling", "__init__.py")), "extracted module missing");
  const probe = execFileSync(python, ["-c", "import docling; print(docling.OK)"], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: packDir },
  }).trim();
  assert(probe === "True", `pack not importable via PYTHONPATH: ${probe}`);

  // State file matches runtime-packs.js shape (installed[id].source/version).
  const state = JSON.parse(fs.readFileSync(path.join(userData, "runtime-packs.json"), "utf8"));
  assert(state.installed["pro-pdf"]?.source === "artifact" && state.installed["pro-pdf"]?.version === "9.9.9", `bad state: ${JSON.stringify(state)}`);
  assert((await run(["status", "pro-pdf"])).installed === true, "status should report installed");

  const loInstalled = await run(["install", "libreoffice"]);
  assert(loInstalled.ok && loInstalled.installed === "libreoffice", `libreoffice install failed: ${JSON.stringify(loInstalled)}`);
  assert(
    fs.existsSync(path.join(userData, "runtime-packs", "libreoffice", "program", "soffice.exe")),
    "LibreOffice zip should extract program/soffice.exe",
  );
  const loState = JSON.parse(fs.readFileSync(path.join(userData, "runtime-packs.json"), "utf8"));
  assert(loState.installed.libreoffice?.format === "zip", `LibreOffice state should record zip format: ${JSON.stringify(loState)}`);

  // sha256 mismatch must be rejected and leave nothing behind.
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.rmSync(path.join(userData, "runtime-packs.json"), { force: true });
  const bad = await run(["install", "pro-pdf"], badEnv);
  assert(!bad.ok && /SHA256_MISMATCH/.test(bad.error), `expected sha256 rejection: ${JSON.stringify(bad)}`);
  assert(!fs.existsSync(packDir), "failed install must not leave a pack dir");

  // Reinstall then uninstall removes the dir and state.
  await run(["install", "pro-pdf"]);
  const removed = await run(["uninstall", "pro-pdf"]);
  assert(removed.ok, `uninstall failed: ${JSON.stringify(removed)}`);
  assert(!fs.existsSync(packDir), "uninstall must remove pack dir");
  assert((await run(["status", "pro-pdf"])).installed === false, "status should report uninstalled");
} finally {
  server.close();
  badServer.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-manage-runtime-pack: ok (runtime-backed)");
