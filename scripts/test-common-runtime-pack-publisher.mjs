#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(ROOT, "scripts/publish-common-runtime-pack.mjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

assert.match(pkg.scripts["release:runtime-pack"], /publish-common-runtime-pack\.mjs/, "package script must expose common runtime pack publishing");

for (const pack of ["web-automation", "ffmpeg", "pandoc"]) {
  assert.match(script, new RegExp(pack.replace("-", "-")), `publisher must support ${pack}`);
}

assert.match(script, /@playwright\/mcp/, "web runtime artifact must include Playwright MCP");
assert.match(script, /PLAYWRIGHT_BROWSERS_PATH/, "web runtime artifact must bundle/verify browser cache");
assert.match(script, /ffmpeg-static/, "ffmpeg runtime artifact must include ffmpeg-static");
assert.match(script, /ffprobe-static/, "ffmpeg runtime artifact must include ffprobe-static");
assert.match(script, /github\.com\/jgm\/pandoc\/releases/, "pandoc runtime artifact must use official pandoc release binaries");
assert.match(script, /POST|runtime-packs/, "publisher must register artifacts with the runtime-pack API");
assert.match(script, /refusing to publish unverified native\/browser binaries/, "publisher must fail loud on unverified cross-platform native/browser packs");

console.log("common-runtime-pack-publisher: ok");
