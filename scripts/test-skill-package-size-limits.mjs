#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const EXPECTED_LIMIT_BYTES = 200 * 1024 * 1024;

const skillInstaller = require("../src/main/skill-installer.js");
const githubInstaller = require("../src/main/skill-github-installer.js");
const skillPackages = await import("../server/src/services/skill-packages.js");
const serverLimits = await import("../server/src/limits.js");

assert.equal(
  skillInstaller.MAX_SKILLPACK_BYTES,
  EXPECTED_LIMIT_BYTES,
  "remote skillpack download limit must allow 200MB packages",
);
assert.equal(
  githubInstaller.MAX_SKILL_DIR_BYTES,
  EXPECTED_LIMIT_BYTES,
  "GitHub skill directory install limit must allow 200MB packages",
);
assert.equal(
  skillPackages.MAX_SKILL_PACKAGE_BYTES,
  EXPECTED_LIMIT_BYTES,
  "server skill package validation limit must allow 200MB packages",
);
assert.equal(
  serverLimits.ADMIN_UPLOAD_LIMIT_BYTES,
  EXPECTED_LIMIT_BYTES,
  "server admin upload limit must allow 200MB skill packages",
);

const buildScript = fs.readFileSync(path.join(ROOT, "scripts/build-skill-pack.mjs"), "utf8");
assert.match(
  buildScript,
  /const MAX_PACK_BYTES = 200 \* 1024 \* 1024;/,
  "skill pack builder must allow 200MB packages",
);

console.log("skill-package-size-limits: ok");
