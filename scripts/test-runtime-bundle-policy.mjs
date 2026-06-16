#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const policy = await import(pathToFileURL(path.join(__dirname, "../src/main/runtime-bundle-policy.js")).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-policy-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const runtimeRoot = path.join(root, "runtime");
  const sitePackages = path.join(runtimeRoot, "venv", "lib", "python3.12", "site-packages");
  fs.mkdirSync(sitePackages, { recursive: true });
  fs.mkdirSync(path.join(sitePackages, "pandas"));
  assert(policy.findAppOnlyRuntimePackages(runtimeRoot, "darwin-arm64").length === 0, "common runtime packages should pass");

  fs.mkdirSync(path.join(sitePackages, "akshare"));
  fs.mkdirSync(path.join(sitePackages, "lark_oapi"));
  const found = policy.findAppOnlyRuntimePackages(runtimeRoot, "darwin-arm64").map((item) => item.name);
  assert(found.includes("akshare"), "stock app dependency should be blocked");
  assert(found.includes("lark_oapi"), "workspace app integration dependency should be blocked");

  console.log("runtime-bundle-policy: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
