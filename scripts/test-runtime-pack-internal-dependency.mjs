#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-pack-internal-"));
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");
process.env.LILY_RUNTIME_PACK_ROOT = path.join(tmp, "runtime-packs");

const installer = await import(`../src/main/runtime-pack-installer.js?test=${Date.now()}`);
const specs = await import(`../src/main/runtime-pack-specs.js?test=${Date.now()}`);
assert.equal(specs.PACK_SPECS.git.internal, true);
const catalog = installer.listRuntimePacks();
assert.equal(catalog.ok, true);
assert.equal(catalog.packs.some((pack) => pack.id === "git"), false);
assert.equal(catalog.categories.some((category) => category.id === "system"), false);

console.log("runtime-pack-internal-dependency: ok");
