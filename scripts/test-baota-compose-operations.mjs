#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const deployDir = path.join(root, "deploy", "baota");
const read = (name) => fs.readFileSync(path.join(deployDir, name), "utf8");

const operations = read("compose.sh");
for (const mode of [
  "docker-compose.yml",
  "docker-compose.external-postgres.yml",
  "docker-compose.app-only.yml",
  "docker-compose.images-app-only.yml",
]) {
  assert.match(operations, new RegExp(mode.replaceAll(".", "\\.")), `compose wrapper must select ${mode}`);
}
assert.match(operations, /DEPLOY_MODE/);
assert.match(operations, /GATEWAY_MODE/);
assert.match(operations, /DB_MODE/);
assert.match(operations, /--profile bundled/, "bundled topology requires an explicit profile");

const deploy = read("deploy.sh");
assert.match(deploy, /\.\/compose\.sh up -d/, "deploy must use the same mode-aware operations wrapper");
assert.doesNotMatch(deploy, /docker(?:-compose| compose).* up -d/, "deploy must not bypass mode selection");

const bundled = read("docker-compose.yml");
assert.equal((bundled.match(/profiles:\s*\["bundled"\]/g) || []).length, 4, "bare compose up must not select bundled services");

const readme = read("README.md");
assert.doesNotMatch(readme, /^docker(?:-compose| compose)\s+(?:up|down|restart|ps|logs)\b/gm, "operator docs must not bypass mode selection");
for (const command of ["ps", "logs -f api", "restart", "down"]) {
  assert.ok(readme.includes(`./compose.sh ${command}`), `README must document ./compose.sh ${command}`);
}

console.log("baota-compose-operations: ok");
