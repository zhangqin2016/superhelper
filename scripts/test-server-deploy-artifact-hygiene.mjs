#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const relativePath of [
  "deploy/baota/push-images-via-qiniu.sh",
  "deploy/baota/push-via-qiniu.sh",
]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.match(source, /COPYFILE_DISABLE=1/, `${relativePath} must disable macOS metadata archiving`);
  assert.match(source, /--exclude "\._\*"/, `${relativePath} must exclude AppleDouble sidecar files`);
}

console.log("server-deploy-artifact-hygiene: ok");
