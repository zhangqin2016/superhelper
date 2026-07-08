#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, finish } from "./lib/test-assert.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(ROOT, "resources", "skills-catalog", "lily-runtime-packs", "scripts", "manage_runtime_pack.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-pack-skill-"));
const userData = path.join(tmp, "userData");
const runtimePackRoot = path.join(tmp, "external-runtime-root");
const fallbackRuntimeRoot = path.join(tmp, "fallback-runtime-root");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(path.join(fallbackRuntimeRoot, "runtime-packs", "rapidocr"), { recursive: true });
fs.writeFileSync(
  path.join(fallbackRuntimeRoot, "runtime-packs.json"),
  JSON.stringify({ schemaVersion: 1, installed: { rapidocr: { source: "artifact", version: "3.3.0" } } }),
  "utf8",
);
fs.writeFileSync(
  path.join(userData, "runtime-pack-root.json"),
  JSON.stringify({ root: runtimePackRoot, fallbackRoots: [fallbackRuntimeRoot], updatedAt: "2026-01-01T00:00:00.000Z" }),
  "utf8",
);
const archive = path.join(tmp, "pack.zip");
const payloadDir = path.join(tmp, "payload");
fs.mkdirSync(payloadDir, { recursive: true });
fs.writeFileSync(path.join(payloadDir, "hello.txt"), "runtime pack payload\n", "utf8");

const zipResult = spawnSync("zip", ["-qr", archive, "."], { cwd: payloadDir, encoding: "utf8" });
if (zipResult.status !== 0) {
  console.log("PASS: test-runtime-pack-skill-progress (skipped: zip unavailable)");
  process.exit(0);
}

const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/api/runtime-packs/artifact") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      artifact: {
        url: `http://127.0.0.1:${server.address().port}/pack.zip`,
        sha256,
        version: "0.0.1-test",
        format: "zip",
      },
    }));
    return;
  }
  if (url.pathname === "/pack.zip") {
    res.setHeader("content-type", "application/zip");
    fs.createReadStream(archive).pipe(res);
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const result = await new Promise((resolve) => {
    const child = spawn("python3", [script, "install", "pandoc"], {
      env: {
        ...process.env,
        LILY_USER_DATA_DIR: userData,
        LILY_RUNTIME_PACK_ROOT: "",
        LILY_SERVICE_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        PATH: process.env.PATH || "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert(result.status === 0, `runtime pack install should succeed: stdout=${result.stdout} stderr=${result.stderr}`);
  const listResult = spawnSync("python3", [script, "list"], {
    env: {
      ...process.env,
      LILY_USER_DATA_DIR: userData,
      LILY_RUNTIME_PACK_ROOT: "",
      LILY_SERVICE_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      PATH: process.env.PATH || "",
    },
    encoding: "utf8",
  });
  assert(listResult.status === 0, `runtime pack list should succeed: stdout=${listResult.stdout} stderr=${listResult.stderr}`);
  const listed = JSON.parse(listResult.stdout.trim());
  assert(
    listed.packs.some((pack) => pack.id === "rapidocr" && pack.installed && pack.path === path.join(fallbackRuntimeRoot, "runtime-packs", "rapidocr")),
    `fallback runtime pack should remain visible to the agent script: ${listResult.stdout}`,
  );
  const parsed = JSON.parse(result.stdout.trim());
  assert(parsed.ok === true && parsed.installed === "pandoc", `final JSON should report install: ${result.stdout}`);
  assert(result.stderr.includes("[lily-progress]"), `installer must emit lily progress markers: ${result.stderr}`);
  assert(result.stderr.includes('"domain": "runtime-pack"'), `progress must use runtime-pack domain: ${result.stderr}`);
  for (const status of ["resolving", "downloading", "verifying", "extracting", "installed"]) {
    assert(result.stderr.includes(`"status": "${status}"`), `progress missing ${status}: ${result.stderr}`);
  }
  assert(fs.existsSync(path.join(runtimePackRoot, "runtime-packs", "pandoc", "hello.txt")), "artifact should be extracted under selected runtime-pack root");
  assert(fs.existsSync(path.join(runtimePackRoot, "runtime-packs.json")), "state should be written beside the selected runtime-pack root");
  assert(!fs.existsSync(path.join(userData, "runtime-packs", "pandoc")), "selected runtime-pack root must not copy pack contents into userData");
  finish("test-runtime-pack-skill-progress", 10);
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
