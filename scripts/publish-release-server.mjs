#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(`usage:
  node scripts/publish-release-server.mjs \\
    --api https://api.example.com \\
    [--token ADMIN_TOKEN | --email admin@example.com --password ADMIN_PASSWORD] \\
    --version 0.2.0 \\
    --artifact darwin-arm64=dist/Lily\\ Workbench-0.2.0-arm64.dmg=https://cdn/app.dmg \\
    [--notes "release notes"] [--force] [--disabled]

env:
  RELEASE_ADMIN_TOKEN
  RELEASE_ADMIN_EMAIL
  RELEASE_ADMIN_PASSWORD
`);
  process.exit(1);
}

function args() {
  const out = { artifact: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) usage();
    const name = key.slice(2);
    if (["force", "disabled"].includes(name)) {
      out[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) usage();
    i += 1;
    if (name === "artifact") out.artifact.push(value);
    else out[name] = value;
  }
  return out;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArtifact(raw) {
  const first = raw.indexOf("=");
  const second = raw.indexOf("=", first + 1);
  if (first <= 0 || second <= first) usage();
  const platform = raw.slice(0, first);
  const file = raw.slice(first + 1, second);
  const url = raw.slice(second + 1);
  if (!fs.existsSync(file)) throw new Error(`artifact file not found: ${file}`);
  return {
    platform,
    file,
    url,
    sha256: sha256(file),
    sizeBytes: fs.statSync(file).size,
  };
}

const options = args();
options.token = options.token || process.env.RELEASE_ADMIN_TOKEN || "";
options.email = options.email || process.env.RELEASE_ADMIN_EMAIL || "";
options.password = options.password || process.env.RELEASE_ADMIN_PASSWORD || "";
if (!options.api || !options.version || !options.artifact.length) usage();
if (!options.token && (!options.email || !options.password)) usage();

const api = String(options.api).replace(/\/+$/, "");
let authHeaders = options.token ? { Authorization: `Bearer ${options.token}` } : null;

if (!authHeaders) {
  const loginResponse = await fetch(`${api}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: options.email,
      password: options.password,
    }),
  });
  const loginJson = await loginResponse.json().catch(() => ({}));
  if (!loginResponse.ok) {
    throw new Error(`admin login failed: ${loginResponse.status} ${loginJson.code || ""}`);
  }
  const setCookie = loginResponse.headers.get("set-cookie") || "";
  const session = setCookie.match(/(?:^|,\s*)lily_admin_session=([^;]+)/)?.[1];
  if (!session) throw new Error("admin login did not return lily_admin_session cookie");
  authHeaders = { Cookie: `lily_admin_session=${session}` };
}

for (const artifact of options.artifact.map(parseArtifact)) {
  const response = await fetch(`${api}/api/admin/releases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      version: options.version,
      platform: artifact.platform,
      url: artifact.url,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      notes: options.notes || null,
      forceUpdate: Boolean(options.force),
      enabled: !options.disabled,
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${artifact.platform} failed: ${response.status} ${json.code || ""}`);
  }
  console.log(`[release-server] ${artifact.platform} -> ${json.id}`);
}
