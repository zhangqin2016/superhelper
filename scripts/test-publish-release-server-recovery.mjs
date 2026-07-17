#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-publish-release-server-"));
const artifact = path.join(tmp, "Lily Workbench-test.exe");
fs.writeFileSync(artifact, "windows installer bytes", "utf8");
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
const size = fs.statSync(artifact).size;
const scriptUrl = pathToFileURL(path.join(ROOT, "scripts", "publish-release-server.mjs"));

const originalArgv = process.argv;
const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const logs = [];
let postCalls = 0;
let lookupCalls = 0;

console.log = (...args) => logs.push(args.join(" "));
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.endsWith("/api/admin/releases") && options.method === "POST") {
    postCalls += 1;
    return {
      ok: false,
      status: 500,
      async json() {
        return { code: "INTERNAL_ERROR" };
      },
    };
  }
  if (target.endsWith("/api/admin/releases") && options.method === "GET") {
    lookupCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          releases: [
            {
              id: "rel_existing",
              version: "9.9.9",
              platform: "win32-x64",
              url: "https://cdn.example.com/app.exe",
              sha256,
              size_bytes: String(size),
              enabled: true,
            },
          ],
        };
      },
    };
  }
  throw new Error(`unexpected fetch: ${target}`);
};

try {
  process.argv = [
    process.execPath,
    "scripts/publish-release-server.mjs",
    "--api",
    "https://api.example.com",
    "--token",
    "test-token",
    "--version",
    "9.9.9",
    "--artifact",
    `win32-x64=${artifact}=https://cdn.example.com/app.exe`,
  ];
  await import(`${scriptUrl.href}?case=recover-existing-${Date.now()}`);
  assert.equal(postCalls, 1, "publish should try to create the release first");
  assert.equal(lookupCalls, 1, "publish should check for an already-created release after a server error");
  assert(
    logs.some((line) => line.includes("already exists -> rel_existing")),
    "publish should treat an exact existing release as success",
  );
} finally {
  process.argv = originalArgv;
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("publish-release-server-recovery: ok");
