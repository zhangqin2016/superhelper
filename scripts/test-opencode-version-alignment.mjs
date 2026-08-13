#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const expected = "1.18.18";
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const fetchScript = fs.readFileSync("scripts/fetch-opencode-engine.mjs", "utf8");
const versionDoc = fs.readFileSync("docs/opencode-source-version.md", "utf8");

assert.equal(packageJson.dependencies?.["@opencode-ai/sdk"], expected, "SDK must match the bundled engine release");
assert.equal(packageLock.packages?.[""]?.dependencies?.["@opencode-ai/sdk"], expected, "lockfile root SDK declaration must match the bundled engine release");
assert.equal(packageLock.packages?.["node_modules/@opencode-ai/sdk"]?.version, expected, "lockfile SDK package must match the bundled engine release");
assert.match(fetchScript, new RegExp(`\\|\\| \"${expected}\"`), "engine fetch default must match the SDK release");
assert.match(versionDoc, new RegExp(`v${expected}`), "engine source version documentation must match the release");
assert.match(versionDoc, new RegExp(`opencode-ai@${expected}`), "engine package documentation must match the release");
assert.match(versionDoc, new RegExp(`@opencode-ai/sdk@${expected}`), "SDK documentation must match the release");

console.log("opencode version alignment: ok");
