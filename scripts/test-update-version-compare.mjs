#!/usr/bin/env node
/**
 * Why this matters: update detection (`hasUpdate = compareVersions(latest, current) > 0`)
 * gates whether users are offered a new build. The previous hand-rolled split-on-[.-]
 * comparison treated `1.0.0-beta` as EQUAL to `1.0.0` (pre-release tag parsed to 0),
 * so it could miss a stable release that supersedes a pre-release, or mis-rank them.
 * These cases pin correct semver ordering + the fail-safe (return 0, never throw) on junk.
 */
import module from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { isPackaged: false, getPath: () => os.tmpdir(), getVersion: () => "0.0.0" },
    shell: {},
  },
};

const { compareVersions } = require(path.join(ROOT, "src/main/update-manager.js"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

const cases = [
  ["0.1.59", "0.1.58", 1], // patch bump is newer
  ["0.1.58", "0.1.58", 0], // equal
  ["0.1.58", "0.1.59", -1], // older
  ["0.2.0", "0.1.99", 1], // minor beats large patch
  ["1.0.0", "1.0.0-beta", 1], // stable supersedes its pre-release (the old bug: returned 0)
  ["1.0.0-beta", "1.0.0-alpha", 1], // pre-release ordering
  ["v1.2.3", "1.2.3", 0], // tolerate a leading v
  ["garbage", "1.0.0", 0], // junk → fail-safe 0, never throws
  ["", "", 0], // empty → 0
];

for (const [a, b, want] of cases) {
  const got = sign(compareVersions(a, b));
  assert(got === want, `compareVersions(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got}, want ${want}`);
}

console.log("update-version-compare: ok", cases.length, "cases");
