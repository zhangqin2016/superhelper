#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const fetchImpl = globalThis.fetch || nodeFetch;
const DEFAULT_ATTEMPTS = 3;

function nodeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(
      target,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            headers: {
              get(name) {
                const value = response.headers[String(name).toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : value || null;
              },
            },
            async text() {
              return text;
            },
            async json() {
              return JSON.parse(text);
            },
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

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
  const loginResponse = await fetchImpl(`${api}/api/admin/login`, {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameRelease(row, artifact, version) {
  return (
    String(row?.version || "") === String(version || "") &&
    String(row?.platform || "") === String(artifact.platform || "") &&
    String(row?.url || "") === String(artifact.url || "") &&
    String(row?.sha256 || "").toLowerCase() === String(artifact.sha256 || "").toLowerCase() &&
    Number(row?.size_bytes ?? row?.sizeBytes ?? 0) === Number(artifact.sizeBytes || 0) &&
    row?.enabled !== false
  );
}

async function findExistingRelease(artifact) {
  const response = await fetchImpl(`${api}/api/admin/releases`, {
    method: "GET",
    headers: authHeaders,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`admin release lookup failed: ${response.status} ${json.code || ""}`);
  }
  const releases = Array.isArray(json.releases) ? json.releases : [];
  return releases.find((row) => sameRelease(row, artifact, options.version)) || null;
}

async function createRelease(artifact) {
  return fetchImpl(`${api}/api/admin/releases`, {
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
}

for (const artifact of options.artifact.map(parseArtifact)) {
  let lastError = null;
  for (let attempt = 1; attempt <= DEFAULT_ATTEMPTS; attempt += 1) {
    try {
      const response = await createRelease(artifact);
      const json = await response.json().catch(() => ({}));
      if (response.ok) {
        console.log(`[release-server] ${artifact.platform} -> ${json.id}`);
        lastError = null;
        break;
      }
      const existing = await findExistingRelease(artifact).catch(() => null);
      if (existing) {
        console.log(`[release-server] ${artifact.platform} already exists -> ${existing.id}`);
        lastError = null;
        break;
      }
      lastError = new Error(`${artifact.platform} failed: ${response.status} ${json.code || ""}`);
    } catch (error) {
      const existing = await findExistingRelease(artifact).catch(() => null);
      if (existing) {
        console.log(`[release-server] ${artifact.platform} already exists -> ${existing.id}`);
        lastError = null;
        break;
      }
      lastError = error;
    }
    if (attempt < DEFAULT_ATTEMPTS) {
      await sleep(1000 * attempt);
    }
  }
  if (lastError) {
    throw lastError;
  }
}
