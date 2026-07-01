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
assert.match(
  distWin,
  /ensure-win-libreoffice-runtime\.mjs/,
  "dist:win must restore the published Windows LibreOffice runtime before verification",
);
assert.match(
  distWin,
  /verify-runtime-bundle\.mjs --platform win32-x64 --require-libreoffice --strict-smoke --allow-cross-host-smoke-skip/,
  "dist:win must require the bundled Windows runtime while allowing Mac release hosts to skip Windows-only smoke",
);
assert.doesNotMatch(
  distWin,
  /--allow-missing/,
  "dist:win must not allow missing runtime in release builds",
);
assert.match(
  distWin,
  /verify-win-pack\.mjs --expect-runtime/,
  "dist:win must verify the packaged Windows runtime after packaging",
);

const distWinSigned = pkg.scripts["dist:win:signed"] || "";
assert.match(
  distWinSigned,
  /verify-runtime-bundle\.mjs --platform win32-x64 --require-libreoffice --strict-smoke/,
  "dist:win:signed must require the bundled Windows runtime before packaging",
);
assert.doesNotMatch(
  distWinSigned,
  /--allow-cross-host-smoke-skip/,
  "dist:win:signed must keep the Windows runtime smoke strict for signed Windows release hosts",
);
assert.doesNotMatch(
  distWinSigned,
  /--allow-missing/,
  "dist:win:signed must not allow missing runtime in release builds",
);
assert.match(
  distWinSigned,
  /verify-win-pack\.mjs --expect-runtime/,
  "dist:win:signed must verify the packaged Windows runtime after packaging",
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
