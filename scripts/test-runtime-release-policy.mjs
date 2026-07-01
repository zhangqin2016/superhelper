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

const distWin = pkg.scripts["dist:win"] || "";
assert.doesNotMatch(
  distWin,
  /ensure-win-libreoffice-runtime|verify-runtime-bundle\.mjs|--require-libreoffice/,
  "dist:win must stay slim and must not build, restore, or verify bundled Windows runtime dependencies",
);
assert.doesNotMatch(
  distWin,
  /--expect-runtime/,
  "dist:win must verify the default slim package, not a full offline runtime package",
);
assert.match(
  distWin,
  /verify-win-pack\.mjs/,
  "dist:win must verify the packaged Windows installer after packaging",
);

const distWinSigned = pkg.scripts["dist:win:signed"] || "";
assert.doesNotMatch(
  distWinSigned,
  /ensure-win-libreoffice-runtime|verify-runtime-bundle\.mjs|--require-libreoffice/,
  "dist:win:signed must stay slim and must not build, restore, or verify bundled Windows runtime dependencies",
);
assert.doesNotMatch(
  distWinSigned,
  /--expect-runtime/,
  "dist:win:signed must verify the default slim package, not a full offline runtime package",
);
assert.match(
  distWinSigned,
  /verify-win-pack\.mjs/,
  "dist:win:signed must verify the packaged Windows installer after packaging",
);

const winResources = pkg.build?.win?.extraResources || [];
const winFilters = winResources.flatMap((resource) =>
  Array.isArray(resource.filter) ? resource.filter.map(String) : [],
);
assert(
  winFilters.includes("!runtime/**"),
  "Windows installer resources must hard-exclude bundled runtime dependencies",
);
assert(
  winFilters.includes("!runtime-packs/**"),
  "Windows installer resources must hard-exclude bundled runtime packs",
);

const verifyWinPack = fs.readFileSync(path.join(ROOT, "scripts/verify-win-pack.mjs"), "utf8");
assert.match(
  verifyWinPack,
  /默认 Windows 安装包必须保持 slim/,
  "Windows package verifier must fail if the default installer accidentally includes runtime dependencies",
);

for (const workflow of [
  ".github/workflows/release.yml",
  ".github/workflows/build-installers.yml",
  ".github/workflows/dist-windows-slim.yml",
]) {
  const text = fs.readFileSync(path.join(ROOT, workflow), "utf8");
  assert.doesNotMatch(
    text,
    /Build runtime bundle \(win32-x64\)|verify-win-pack\.mjs --expect-runtime/,
    `${workflow} must build and verify the default slim Windows installer`,
  );
}
assert(
  !fs.existsSync(path.join(ROOT, ".github/workflows/dist-windows-full.yml")),
  "default Windows workflow must not keep a stale full-installer entry point",
);

const verifyRuntime = fs.readFileSync(path.join(ROOT, "scripts/verify-runtime-bundle.mjs"), "utf8");
assert.match(verifyRuntime, /--require-libreoffice/, "runtime verifier must support a strict LibreOffice gate");
assert.match(verifyRuntime, /--strict-smoke/, "runtime verifier must support strict import smoke checks");
assert.match(
  verifyRuntime,
  /--allow-cross-host-smoke-skip/,
  "runtime verifier must support explicit cross-host Windows smoke skipping",
);

console.log("runtime-release-policy: ok");
