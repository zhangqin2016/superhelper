#!/usr/bin/env node
/**
 * One rule decides whether the registry offers a pack this machine lacks:
 * a higher version, or the same version as a different file.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { registryUpdate } = require("../src/main/skill-version.js");
const a = "a".repeat(64), b = "b".repeat(64);
const entry = (v, sha, extra = {}) => ({ latestVersion: v, sha256: sha, sourceType: "zip", ...extra });
assert.deepEqual(registryUpdate(entry("1.0.2", a), "1.0.1", a), { available: true, reason: "version" });
assert.deepEqual(registryUpdate(entry("1.0.1", b), "1.0.1", a), { available: true, reason: "content" }, "same version, different pack");
assert.deepEqual(registryUpdate(entry("1.0.1", a.toUpperCase()), "1.0.1", a), { available: false, reason: null }, "digest case does not matter");
assert.equal(registryUpdate(entry("1.0.0", b), "1.0.1", a).available, false, "an older registry never downgrades");
assert.equal(registryUpdate(entry("1.0.1", b), "1.0.1", "").available, false, "no recorded digest: version rules only");
assert.equal(registryUpdate(entry("1.0.1", "not-a-digest"), "1.0.1", a).available, false, "a malformed digest is not evidence");
assert.equal(registryUpdate(entry("1.0.1", b, { sourceType: "github" }), "1.0.1", a).available, false, "GitHub sources carry no pack digest");
assert.equal(registryUpdate(null, "1.0.1", a).available, false);
const { installedRegistryDigest } = require("../src/main/skill-version.js");
assert.equal(installedRegistryDigest({ source: "remote", sha256: a }), a, "a registry-installed copy is compared by digest");
assert.equal(installedRegistryDigest({ source: "bundled", sha256: a }), "", "a bundled copy is the app's own: never offered a registry update by digest");
assert.equal(registryUpdate(entry("1.0.1", b), "1.0.1", installedRegistryDigest({ source: "bundled", sha256: a })).available, false, "the mandatory skill on 2026-09-26: no phantom update");
console.log("skill-registry-update: ok (11 checks)");
