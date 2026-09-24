#!/usr/bin/env node
// What ships to the server is a commit. Both deploy scripts once packaged or
// built from the working tree while tagging the images with the HEAD sha, so a
// deploy carried another stream's uncommitted work — including a database
// migration — toward production under a tag that did not contain it. The
// scripts now export the commit (git archive) and build/package only that;
// tracked files alone also means no macOS AppleDouble sidecars can ship.
// [gate: server-deploy-from-commit]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const helper = read("deploy/baota/commit-source.sh");
assert.match(helper, /git -C "\$_root" archive "\$DEPLOY_REF" \.dockerignore server web deploy\/baota \| tar -x -C "\$_dest"/, "the source is exported from the commit");
assert.match(helper, /status --porcelain/, "uncommitted paths are named, not dropped silently");

for (const relativePath of ["deploy/baota/push-images-via-qiniu.sh", "deploy/baota/push-via-qiniu.sh"]) {
  const source = read(relativePath);
  assert.match(source, /\. "\$ROOT\/deploy\/baota\/commit-source\.sh"/, `${relativePath} uses the commit export`);
  assert.match(source, /export_commit_source "\$ROOT"/, `${relativePath} exports before it builds or packages`);
}
// Every source tar reads the export: after the cd into it, or pointed at it.
const images = read("deploy/baota/push-images-via-qiniu.sh");
const exportCd = images.indexOf('cd "$WORK_DIR/source"');
for (const match of images.matchAll(/-czf "\$SOURCE_ARCHIVE"/g)) {
  assert.ok(match.index > exportCd, "the remote-build source tar is taken from the exported commit");
}
assert.match(read("deploy/baota/push-via-qiniu.sh"), /tar -czf "\$ARCHIVE" -C "\$SOURCE_DIR" \.dockerignore server web deploy\/baota/, "the server package is taken from the exported commit");
assert.ok(images.indexOf('cd "$WORK_DIR/source"') < images.indexOf("docker buildx build"), "local image builds use the exported commit as context");
assert.match(images, /IMAGE_TAG="\$\{IMAGE_TAG:-\$\(cd "\$ROOT" && git rev-parse --short "\$\{DEPLOY_REF:-HEAD\}"\)\}"/, "the tag names the exported ref");

// Behaviour, not only text: an uncommitted file never reaches the export.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lily-deploy-export-"));
try {
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  for (const dir of ["server", "web", "deploy/baota"]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, ".dockerignore"), "node_modules\n");
  fs.writeFileSync(path.join(repo, "server/committed.js"), "ok\n");
  fs.writeFileSync(path.join(repo, "web/page.js"), "ok\n");
  fs.writeFileSync(path.join(repo, "deploy/baota/deploy.sh"), "true\n");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "server/committed.js"), "modified\n");
  fs.mkdirSync(path.join(repo, "server/migrations"), { recursive: true });
  fs.writeFileSync(path.join(repo, "server/migrations/055_uncommitted.sql"), "create table x();\n");
  fs.writeFileSync(path.join(repo, "server/._committed.js"), "appledouble\n");
  const dest = path.join(repo, ".export");
  const out = execFileSync("sh", ["-c", `. "${path.join(root, "deploy/baota/commit-source.sh")}"; export_commit_source "${repo}" "${dest}"`]).toString();
  assert.equal(fs.readFileSync(path.join(dest, "server/committed.js"), "utf8"), "ok\n", "the committed content ships, not the edit");
  assert.ok(!fs.existsSync(path.join(dest, "server/migrations/055_uncommitted.sql")), "an uncommitted migration never ships");
  assert.ok(!fs.existsSync(path.join(dest, "server/._committed.js")), "nor an AppleDouble sidecar");
  assert.match(out, /NOT included/, "and the operator is told what was left out");
  assert.match(out, /055_uncommitted\.sql/);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log("server-deploy-artifact-hygiene: ok");
