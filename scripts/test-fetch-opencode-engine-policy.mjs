#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./fetch-opencode-engine.mjs", import.meta.url), "utf8");

assert.match(source, /npm_config_os:\s*targetOs/);
assert.match(source, /npm_config_cpu:\s*targetArch/);
assert.match(
  source,
  /if\s*\(!fs\.existsSync\(installedPlatformPackage\)\)[\s\S]*\["pack", "--silent", `\$\{pkg\}@\$\{version\}`\]/,
  "cross-architecture fetch must pack a platform package filtered from optional dependencies",
);
assert.match(
  source,
  /\["-xzf", archivePath, "-C", installedPlatformPackage, "--strip-components=1"\]/,
  "the downloaded platform package must be extracted into node_modules",
);

console.log("fetch-opencode-engine-policy: ok");
