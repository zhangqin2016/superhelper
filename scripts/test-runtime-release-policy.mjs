#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const macResources = pkg.build?.mac?.extraResources || [];
for (const resource of macResources) {
  const filters = Array.isArray(resource.filter) ? resource.filter : [];
  assert(
    !filters.some((filter) => String(filter).includes("runtime/libreoffice")),
    "Mac release resources must not exclude LibreOffice from the bundled runtime",
  );
}

assert.match(
  pkg.scripts["dist:mac:arm64"],
  /verify-runtime-bundle\.mjs --platform darwin-arm64 --require-libreoffice --strict-smoke/,
  "Mac arm64 release must require LibreOffice before packaging",
);
assert.match(
  pkg.scripts["dist:mac:x64"],
  /verify-runtime-bundle\.mjs --platform darwin-x64 --require-libreoffice --strict-smoke/,
  "Mac x64 release must require LibreOffice before packaging",
);

for (const scriptName of ["dist:win", "dist:win:signed"]) {
  const script = pkg.scripts[scriptName] || "";
  assert.match(
    script,
    /verify-runtime-bundle\.mjs --platform win32-x64 --require-libreoffice --strict-smoke/,
    `${scriptName} must require the bundled Windows runtime before packaging`,
  );
  assert.doesNotMatch(
    script,
    /--allow-missing/,
    `${scriptName} must not allow missing runtime in release builds`,
  );
  assert.match(
    script,
    /verify-win-pack\.mjs --expect-runtime/,
    `${scriptName} must verify the packaged Windows runtime after packaging`,
  );
}

const verifyRuntime = fs.readFileSync(path.join(ROOT, "scripts/verify-runtime-bundle.mjs"), "utf8");
assert.match(verifyRuntime, /--require-libreoffice/, "runtime verifier must support a strict LibreOffice gate");
assert.match(verifyRuntime, /--strict-smoke/, "runtime verifier must support strict import smoke checks");

console.log("runtime-release-policy: ok");
