#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(ROOT, "scripts/publish-common-runtime-pack.mjs"), "utf8");
const pythonPackBuilder = fs.readFileSync(path.join(ROOT, "scripts/build-runtime-pack.mjs"), "utf8");
const specs = fs.readFileSync(path.join(ROOT, "src/main/runtime-pack-specs.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

assert.match(pkg.scripts["release:runtime-pack"], /publish-common-runtime-pack\.mjs/, "package script must expose common runtime pack publishing");

for (const pack of ["web-automation", "ffmpeg", "pandoc"]) {
  assert.match(script, new RegExp(pack.replace("-", "-")), `publisher must support ${pack}`);
}

assert.match(script, /@playwright\/mcp/, "web runtime artifact must include Playwright MCP");
assert.match(script, /PLAYWRIGHT_BROWSERS_PATH/, "web runtime artifact must bundle/verify browser cache");
assert.match(script, /ffmpeg-static/, "ffmpeg runtime artifact must include ffmpeg-static");
assert.match(script, /ffprobe-static/, "ffmpeg runtime artifact must include ffprobe-static");
assert.match(script, /cmd\.exe/, "publisher must route npm through cmd.exe when spawned from Node on Windows");
assert.match(script, /ComSpec/, "publisher should respect the Windows shell path from ComSpec");
assert.match(script, /result\.error/, "publisher must surface spawn errors instead of only saying npm failed");
assert.match(script, /github\.com\/jgm\/pandoc\/releases/, "pandoc runtime artifact must use official pandoc release binaries");
assert.match(script, /POST|runtime-packs/, "publisher must register artifacts with the runtime-pack API");
assert.match(script, /refusing to publish unverified native\/browser binaries/, "publisher must fail loud on unverified cross-platform native/browser packs");
assert.match(pythonPackBuilder, /--register requires RELEASE_ADMIN_TOKEN/, "Python dependency pack builder must support server registration");
assert.match(pythonPackBuilder, /release-admin\.mjs/, "Python dependency pack builder must support CDN upload");
assert.match(pythonPackBuilder, /updateRuntimePackLock/, "verified Python packs must update the release lock");
assert.match(script, /updateRuntimePackLock/, "verified native/browser packs must update the release lock");
assert.match(script, /chromiumRevision/, "web lock entries must pin the Chromium revision");
for (const pack of ["pillow", "opencv", "rapidocr", "rembg"]) {
  assert.match(specs, new RegExp(`${pack}:|\"${pack}\"`), `dependency catalog must include ${pack}`);
}
assert.match(
  specs,
  /rembg:[\s\S]*numpy>=1\.26,<2\.5/,
  "rembg runtime pack must carry a NumPy pin compatible with numba/pymatting",
);
assert.match(
  specs,
  /rembg:[\s\S]*numba>=0\.61,<0\.63/,
  "rembg runtime pack must stay on a numba line that ships Python 3.12 Intel Mac wheels",
);
for (const category of ["document", "image", "browser", "media"]) {
  assert.match(specs, new RegExp(`id: "${category}"`), `dependency catalog must include ${category} group`);
}

console.log("common-runtime-pack-publisher: ok");
