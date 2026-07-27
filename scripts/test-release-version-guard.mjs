#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assertRemoteReleaseNotNewer,
  compareReleaseVersions,
} from "./lib/release-version-guard.mjs";

assert.equal(compareReleaseVersions("0.1.143", "0.1.143"), 0);
assert.equal(compareReleaseVersions("0.1.142", "0.1.143"), -1);
assert.equal(compareReleaseVersions("0.1.144", "0.1.143"), 1);
assert.doesNotThrow(() => assertRemoteReleaseNotNewer("0.1.142", "0.1.143"));
assert.doesNotThrow(() => assertRemoteReleaseNotNewer("0.1.143", "0.1.143"));
assert.throws(
  () => assertRemoteReleaseNotNewer("0.1.144", "0.1.143"),
  /refusing to replace newer remote release 0\.1\.144 with 0\.1\.143/,
);
assert.throws(
  () => assertRemoteReleaseNotNewer("unexpected", "0.1.143"),
  /invalid release version/,
);

const releaseSource = fs.readFileSync("scripts/release-one-click.mjs", "utf8");
assert.ok(
  (releaseSource.match(/assertRemoteReleaseNotNewer\(/g) || []).length >= 2,
  "one-click release must guard both base-manifest intake and the final latest-pointer write",
);

console.log("release-version-guard: ok");
