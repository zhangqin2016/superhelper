#!/usr/bin/env node
//
// Tests the agent-facing pack manager (resources/skills-catalog/lily-document-packs/
// scripts/manage_pack.py) end to end, offline: a localhost server stands in for
// our API + Qiniu CDN. Verifies resolve → download → sha256 → extract → state,
// and that the on-disk layout matches what the main process (document-packs.js)
// reads — pack dir + document-packs.json.
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
const SCRIPT = path.join(ROOT, "resources", "skills-catalog", "lily-document-packs", "scripts", "manage_pack.py");

assert(fs.existsSync(SCRIPT), "manage_pack.py must exist in the skill");

const python = resolveVenvPython();
if (!python) {
  console.log("test-manage-pack: ok (SKIPPED — no bundled runtime)");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-managepack-"));
const userData = path.join(tmp, "userData");
fs.mkdirSync(userData, { recursive: true });

// Stub artifact tarball containing a `docling` package (sync tar is fine — no
// server is listening yet).
const stage = path.join(tmp, "stage");
fs.mkdirSync(path.join(stage, "docling"), { recursive: true });
fs.writeFileSync(path.join(stage, "docling", "__init__.py"), "OK = True\n");
const tarPath = path.join(tmp, "pro-pdf.tar.gz");
execFileSync("tar", ["-czf", tarPath, "-C", stage, "."]);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarPath)).digest("hex");

function makeServer(advertisedSha) {
  return http.createServer((req, res) => {
    if (req.url.startsWith("/api/document-packs/artifact")) {
      const base = `http://127.0.0.1:${res.socket.localPort}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ artifact: { url: `${base}/pack.tar.gz`, sha256: advertisedSha, version: "9.9.9", sizeBytes: fs.statSync(tarPath).size } }));
    } else if (req.url.startsWith("/pack.tar.gz")) {
      res.writeHead(200, { "content-type": "application/gzip" });
      fs.createReadStream(tarPath).pipe(res);
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

const baseEnv = { ...process.env, LILY_USER_DATA_DIR: userData, no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost" };
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

const packDir = path.join(userData, "document-packs", "pro-pdf");

try {
  // Fresh: pro-pdf listed, not installed.
  const listed = await run(["list"]);
  assert(listed.ok && listed.packs.some((p) => p.id === "pro-pdf" && !p.installed), `unexpected list: ${JSON.stringify(listed)}`);

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

  // State file matches document-packs.js shape (installed[id].source/version).
  const state = JSON.parse(fs.readFileSync(path.join(userData, "document-packs.json"), "utf8"));
  assert(state.installed["pro-pdf"]?.source === "artifact" && state.installed["pro-pdf"]?.version === "9.9.9", `bad state: ${JSON.stringify(state)}`);
  assert((await run(["status", "pro-pdf"])).installed === true, "status should report installed");

  // sha256 mismatch must be rejected and leave nothing behind.
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.rmSync(path.join(userData, "document-packs.json"), { force: true });
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
console.log("test-manage-pack: ok (runtime-backed)");
