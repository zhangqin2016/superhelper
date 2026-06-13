#!/usr/bin/env node
/**
 * Supply-chain trust rules: skill registry transport must be HTTPS (loopback
 * http only for local dev), artifact URLs/hashes/git refs must be well-formed,
 * and update feeds/downloads must stay on trusted origins. Skills and updates
 * decide what code runs later — a compromised metadata channel must fail
 * closed, not redirect.
 */
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getVersion: () => "0.0.0",
      getPath: () => path.join(os.tmpdir(), "lily-sct"),
    },
    shell: { openExternal: async () => {} },
  },
};

const { isValidRegistryUrl, normalizeRegistryEntry } = require("../src/main/skill-registry.js");

// --- registry transport ---
assert(isValidRegistryUrl("https://skills.example.com/registry.json"), "https registry allowed");
assert(!isValidRegistryUrl("http://skills.example.com/registry.json"), "plain http registry rejected");
assert(isValidRegistryUrl("http://localhost:8787/registry.json"), "loopback http allowed for dev");
assert(isValidRegistryUrl("http://127.0.0.1/r.json"), "127.0.0.1 http allowed for dev");
assert(!isValidRegistryUrl("file:///etc/registry.json"), "file: rejected");
assert(!isValidRegistryUrl("not a url"), "garbage rejected");

// --- zip entries ---
const zipBase = { id: "s1", latestVersion: "1.0.0", sha256: "a".repeat(64) };
assert(
  normalizeRegistryEntry({ ...zipBase, downloadUrl: "https://cdn.example.com/s1.zip" })?.sourceType === "zip",
  "https zip entry accepted",
);
assert(
  normalizeRegistryEntry({ ...zipBase, downloadUrl: "http://cdn.example.com/s1.zip" }) === null,
  "http zip artifact rejected",
);
assert(
  normalizeRegistryEntry({ ...zipBase, downloadUrl: "https://cdn.example.com/s1.zip", sha256: "deadbeef" }) === null,
  "malformed sha256 rejected",
);

// --- github entries ---
const ghBase = { id: "s2", latestVersion: "1.0.0" };
assert(
  normalizeRegistryEntry({ ...ghBase, github: { repo: "org/repo", path: "skills/x", ref: "main" } })?.sourceType === "github",
  "well-formed github entry accepted",
);
assert(
  normalizeRegistryEntry({ ...ghBase, github: { repo: "org/repo", path: "skills/x", ref: "$(curl evil)" } }) === null,
  "shell-metachar ref rejected",
);
assert(
  normalizeRegistryEntry({ ...ghBase, github: { repo: "org/repo;rm -rf", path: "skills/x" } }) === null,
  "malformed repo rejected",
);
assert(
  normalizeRegistryEntry({ ...ghBase, github: { repo: "org/repo", path: "../../etc" } }) === null,
  "path traversal in github path rejected",
);

// --- update feed / download origins ---
const { isTrustedUpdateUrl } = require("../src/main/update-manager.js");
assert(isTrustedUpdateUrl("https://qny.lanrensoft.cn/app/auto-updates/darwin-arm64/stable"), "default update origin trusted");
assert(!isTrustedUpdateUrl("https://evil.example.com/feed"), "unknown origin rejected");
assert(!isTrustedUpdateUrl("http://qny.lanrensoft.cn/app/auto-updates"), "http downgrade of trusted host rejected");
assert(!isTrustedUpdateUrl("not a url"), "garbage feed rejected");

console.log("PASS: test-supply-chain-trust (17 tests)");
