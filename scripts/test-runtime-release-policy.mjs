#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const macResources = pkg.build?.mac?.extraResources || [];
const macFilters = macResources.flatMap((resource) =>
  Array.isArray(resource.filter) ? resource.filter.map(String) : [],
);
assert(
  !macFilters.includes("!runtime/**"),
  "Mac installer resources must include the base Python runtime so local Python capabilities work offline",
);
assert(
  macFilters.includes("!runtime/libreoffice/**"),
  "Mac installer resources must exclude the incomplete generated LibreOffice folder",
);
assert(
  macFilters.includes("!runtime-packs/**"),
  "Mac installer resources must hard-exclude bundled runtime packs",
);

assert.doesNotMatch(
  pkg.scripts["dist:mac:arm64"],
  /verify-runtime-bundle\.mjs|--require-libreoffice/,
  "Mac arm64 release must not rebuild/require LibreOffice or a full runtime bundle before packaging (Python venv is prebuilt natively)",
);
assert.doesNotMatch(
  pkg.scripts["dist:mac:x64"],
  /verify-runtime-bundle\.mjs|--require-libreoffice/,
  "Mac x64 release must not rebuild/require LibreOffice or a full runtime bundle before packaging (Python venv is prebuilt natively)",
);
assert.match(
  pkg.scripts["dist:mac:arm64"],
  /verify-mac-pack\.mjs/,
  "Mac arm64 release must verify the packaged slim app after packaging",
);
assert.match(
  pkg.scripts["dist:mac:x64"],
  /verify-mac-pack\.mjs/,
  "Mac x64 release must verify the packaged slim app after packaging",
);

const distWin = pkg.scripts["dist:win"] || "";
assert.doesNotMatch(
  distWin,
  /ensure-win-libreoffice-runtime|verify-runtime-bundle\.mjs|--require-libreoffice/,
  "dist:win must not rebuild or restore Windows runtime dependencies during packaging",
);
assert.match(
  distWin,
  /verify-win-pack\.mjs/,
  "dist:win must verify the packaged Windows installer and base runtime after packaging",
);

const distWinSigned = pkg.scripts["dist:win:signed"] || "";
assert.doesNotMatch(
  distWinSigned,
  /ensure-win-libreoffice-runtime|verify-runtime-bundle\.mjs|--require-libreoffice/,
  "dist:win:signed must not rebuild or restore Windows runtime dependencies during packaging",
);
assert.match(
  distWinSigned,
  /verify-win-pack\.mjs/,
  "dist:win:signed must verify the packaged Windows installer and base runtime after packaging",
);

const winResources = pkg.build?.win?.extraResources || [];
const winFilters = winResources.flatMap((resource) =>
  Array.isArray(resource.filter) ? resource.filter.map(String) : [],
);
assert(
  !winFilters.includes("!runtime/**"),
  "Windows installer resources must include the base Python runtime so local Python capabilities work offline",
);
assert(
  winFilters.includes("!runtime/libreoffice/**"),
  "Windows installer resources must exclude the incomplete generated LibreOffice folder",
);
assert(
  winFilters.includes("!runtime-packs/**"),
  "Windows installer resources must hard-exclude bundled runtime packs",
);

const verifyWinPack = fs.readFileSync(path.join(ROOT, "scripts/verify-win-pack.mjs"), "utf8");
assert.match(verifyWinPack, /base Python runtime present/, "Windows package verifier must require the base Python runtime");
assert.match(
  verifyWinPack,
  /incomplete base LibreOffice runtime/,
  "Windows package verifier must reject the incomplete generated LibreOffice folder",
);
assert.match(
  verifyWinPack,
  /bundled runtime-packs/,
  "Windows package verifier must fail if optional runtime packs are bundled",
);

const verifyMacPack = fs.readFileSync(path.join(ROOT, "scripts/verify-mac-pack.mjs"), "utf8");
assert.match(
  verifyMacPack,
  /base Python runtime present/,
  "Mac package verifier must require the base Python runtime",
);
assert.match(
  verifyMacPack,
  /incomplete base LibreOffice runtime/,
  "Mac package verifier must reject the incomplete generated LibreOffice folder",
);
assert.match(
  verifyMacPack,
  /bundled runtime-packs/,
  "Mac package verifier must fail if optional runtime packs are bundled",
);
assert.doesNotMatch(
  verifyMacPack,
  /LibreOffice.*first use|first use.*LibreOffice/,
  "Mac package verifier must not require LibreOffice in the default installer",
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
    `${workflow} must build and verify the default Windows installer`,
  );
}
assert(
  !fs.existsSync(path.join(ROOT, ".github/workflows/dist-windows-full.yml")),
  "default Windows workflow must not keep a stale full-installer entry point",
);

const verifyRuntime = fs.readFileSync(path.join(ROOT, "scripts/verify-runtime-bundle.mjs"), "utf8");
assert.match(verifyRuntime, /--require-libreoffice/, "runtime verifier must support a strict LibreOffice gate");
assert.match(verifyRuntime, /--strict-smoke/, "runtime verifier must support strict import smoke checks");
assert.equal(
  pkg.scripts["release:preflight"],
  "node scripts/release-preflight.mjs",
  "package scripts must expose the dependency/runtime-pack release preflight gate",
);
assert.equal(
  pkg.scripts["deploy:preflight"],
  "node scripts/release-preflight.mjs && node scripts/check-baota-compose.mjs",
  "server deploys must expose a shared preflight gate",
);

const releaseOne = fs.readFileSync(path.join(ROOT, "scripts/release-one-click.mjs"), "utf8");
assert.match(
  releaseOne,
  /scripts\/release-preflight\.mjs/,
  "one-click release must run dependency/runtime-pack preflight before build/publish",
);
assert.match(releaseOne, /LILY_RELEASE_ONLINE_PREFLIGHT/, "one-click uploads must compare locked packs with production");
assert.match(
  releaseOne,
  /LILY_RELEASE_TARGET:\s*target/,
  "one-click release must scope runtime-pack preflight to the selected release target",
);

const releasePreflight = fs.readFileSync(path.join(ROOT, "scripts/release-preflight.mjs"), "utf8");
for (const test of [
  "test-runtime-packs.mjs",
  "test-runtime-pack-release-matrix.mjs",
  "test-spawn-env-runtime.mjs",
  "test-runtime-health.mjs",
  "test-runtime-pack-installer.mjs",
  "test-runtime-pack-preflight.mjs",
  "test-common-runtime-pack-publisher.mjs",
]) {
  assert.match(
    releasePreflight,
    new RegExp(test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `release preflight must run ${test}`,
  );
}
assert.match(releasePreflight, /--strict/, "release preflight must require complete verified platform coverage");
assert.match(releasePreflight, /LILY_RELEASE_ONLINE_PREFLIGHT/, "release preflight must support production artifact comparison");
assert.match(releasePreflight, /LILY_RELEASE_TARGET/, "release preflight must support target-scoped runtime-pack checks");
assert.match(releasePreflight, /--platform/, "release preflight must pass explicit platform scope to the runtime-pack matrix");

for (const deployScript of ["deploy/baota/push-via-qiniu.sh", "deploy/baota/push-images-via-qiniu.sh"]) {
  const text = fs.readFileSync(path.join(ROOT, deployScript), "utf8");
  assert.match(text, /npm run deploy:preflight/, `${deployScript} must run deploy preflight before pushing`);
  assert.match(text, /SKIP_DEPLOY_PREFLIGHT/, `${deployScript} must keep an explicit emergency preflight bypass`);
}
assert.match(
  verifyRuntime,
  /--allow-cross-host-smoke-skip/,
  "runtime verifier must support explicit cross-host Windows smoke skipping",
);

console.log("runtime-release-policy: ok");
