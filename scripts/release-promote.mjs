#!/usr/bin/env node
// Move the shared fallbacks — the stable/ auto-update feeds and the signed
// latest.json — to a version whose rollout has COMPLETED.
//
// A staged release (release-one-click --rollout N / --draft) reaches devices
// only through its own feed; the shared fallbacks stay on the previous
// version, because a fallback that ran ahead of the rollout would hand the new
// build to everyone. This script is the one way forward: it asks the server
// whether every platform of this version is offered to everyone, refuses
// otherwise, then uploads the files release-one-click already prepared under
// release/<version>/, refreshes the CDN and verifies.
//
// usage: node scripts/release-promote.mjs --version 0.2.0 [--dry-run]
//          [--server-api URL] [--bucket B] [--domain D] [--prefix P] [--auto-prefix A] [--up-host H]
// env:   RELEASE_ADMIN_TOKEN
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Same defaults as release-one-click.mjs (held together by test-release-rollouts).
export const PROMOTE_DEFAULTS = {
  bucket: "lanrensoft",
  domain: "https://qny.lanrensoft.cn",
  prefix: "app/updates",
  autoPrefix: "app/auto-updates",
  serverApi: "https://lilych.lilywb.cn",
  upHost: "https://upload.qiniup.com",
};

function fail(message) {
  console.error(`[release-promote] ${message}`);
  process.exit(1);
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === "dry-run") { out.dryRun = true; continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`${key} needs a value`);
    out[name] = value;
    i += 1;
  }
  return out;
}

const trim = (value) => String(value).replace(/^\/+|\/+$/g, "");

/** The uploads promotion performs, from what release-one-click left under release/<version>/. */
export function promotionPlan({ version, root = ROOT, prefix = PROMOTE_DEFAULTS.prefix, autoPrefix = PROMOTE_DEFAULTS.autoPrefix }) {
  const releaseDir = path.join(root, "release", version);
  const manifest = path.join(releaseDir, "latest.json");
  if (!fs.existsSync(manifest)) throw new Error(`${path.relative(root, manifest)} is missing — promote from the machine that published ${version}`);
  const uploads = [{ key: `${trim(prefix)}/latest.json`, file: manifest }];
  const autoDir = path.join(releaseDir, "auto");
  const platforms = fs.existsSync(autoDir) ? fs.readdirSync(autoDir).filter((name) => fs.statSync(path.join(autoDir, name)).isDirectory()) : [];
  for (const platform of platforms) {
    const name = platform.startsWith("darwin-") ? "latest-mac.yml" : "latest.yml";
    const file = path.join(autoDir, platform, name);
    if (!fs.existsSync(file)) throw new Error(`${path.relative(root, file)} is missing`);
    uploads.push({ key: `${trim(autoPrefix)}/${platform}/stable/${name}`, file, platform });
  }
  if (!platforms.length) throw new Error(`no auto-update feeds under ${path.relative(root, autoDir)}`);
  return { platforms, uploads };
}

/** Refuse unless every platform's version-for-everyone is this version. */
export function assertComplete(rolloutsResponse, version, platforms) {
  const byPlatform = new Map((rolloutsResponse?.platforms || []).map((entry) => [entry.platform, entry]));
  const behind = platforms.filter((platform) => byPlatform.get(platform)?.full?.version !== version);
  if (behind.length) {
    const detail = behind.map((platform) => {
      const entry = byPlatform.get(platform);
      const active = entry?.active ? `${entry.active.version} ${entry.active.state} ${entry.active.percent}%` : "no active rollout";
      return `${platform}: everyone gets ${entry?.full?.version || "nothing"} (${active})`;
    }).join("; ");
    throw new Error(`${version} is not offered to everyone yet — complete its rollout first. ${detail}`);
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const version = String(options.version || "").trim();
  if (!version) fail("--version is required");
  const api = String(options["server-api"] || PROMOTE_DEFAULTS.serverApi).replace(/\/+$/g, "");
  const token = process.env.RELEASE_ADMIN_TOKEN || "";
  if (!token) fail("RELEASE_ADMIN_TOKEN is required to confirm the rollout with the server");
  const plan = promotionPlan({ version, prefix: options.prefix, autoPrefix: options["auto-prefix"] });

  const response = await fetch(`${api}/api/admin/rollouts`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) fail(`rollout lookup failed: ${response.status} ${json.code || ""}`);
  try {
    assertComplete(json, version, plan.platforms);
  } catch (error) {
    fail(error.message);
  }

  const domain = String(options.domain || PROMOTE_DEFAULTS.domain).replace(/\/+$/g, "");
  for (const item of plan.uploads) {
    console.log(`[release-promote] ${options.dryRun ? "would upload" : "upload"} ${domain}/${item.key}`);
    if (options.dryRun) continue;
    const run = spawnSync(process.execPath, [path.join(ROOT, "scripts/release-admin.mjs"), "upload",
      "--bucket", options.bucket || PROMOTE_DEFAULTS.bucket, "--key", item.key, "--file", item.file,
      "--up-host", options["up-host"] || PROMOTE_DEFAULTS.upHost], { stdio: "inherit" });
    if (run.status !== 0) fail(`upload of ${item.key} failed`);
  }
  if (options.dryRun) return;
  const urls = plan.uploads.map((item) => `${domain}/${item.key}`);
  // The shared pointers are cached at the edge for a year: refresh them (IPv4 path).
  const refresh = spawnSync(process.execPath, [path.join(ROOT, "scripts/qiniu-ipv4-admin.mjs"), "refresh", ...urls], { stdio: "inherit" });
  if (refresh.status !== 0) console.warn("[release-promote] CDN refresh failed; the new pointers reach clients when the edge cache expires. Retry: node scripts/qiniu-ipv4-admin.mjs refresh " + urls.join(" "));
  for (const url of urls) {
    const text = await fetch(`${url}${url.includes("?") ? "&" : "?"}promote=${Date.now()}`).then((r) => r.text()).catch(() => "");
    if (!text.includes(version)) fail(`${url} does not announce ${version} yet`);
  }
  console.log(`[release-promote] ${version} is now the shared fallback on ${plan.platforms.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error?.message || String(error)));
}
