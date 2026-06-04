"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, shell } = require("electron");
const { userDataPath } = require("./config");
const { loadPublicKey } = require("./license-manager");
const { verifyDetached } = require("./crypto-signing");

const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MANIFEST_URL = "https://lily.lanrensoft.cn/app/updates/latest.json";

function defaultManifestUrl() {
  return process.env.LILY_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL;
}

function getUpdateSettings() {
  return {
    ok: true,
    manifestUrl: defaultManifestUrl(),
    configurable: false,
  };
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || "0").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function currentPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: "FETCH_FAILED", detail: `${response.status} ${response.statusText}` };
    }
    return { ok: true, json: await response.json() };
  } catch (err) {
    return { ok: false, error: "FETCH_FAILED", detail: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function verifyManifest(manifest) {
  const signature = manifest?.signature;
  if (!signature) return { ok: false, error: "MISSING_SIGNATURE" };
  const copy = { ...manifest };
  delete copy.signature;
  if (!verifyDetached(copy, signature, loadPublicKey())) {
    return { ok: false, error: "BAD_SIGNATURE" };
  }
  return { ok: true };
}

async function checkForUpdates() {
  const service = require("./service-client");
  const serviceSettings = service.getServiceSettings();
  if (serviceSettings.apiBaseUrl) {
    const currentVersion = app.getVersion();
    const platformKey = currentPlatformKey();
    const latest = await service.latestRelease(platformKey, currentVersion);
    if (!latest.ok) return latest;
    const release = latest.json || {};
    return {
      ok: true,
      hasUpdate: compareVersions(release.version, currentVersion) > 0,
      currentVersion,
      latestVersion: release.version || currentVersion,
      force: Boolean(release.force),
      notes: release.notes || "",
      platformKey,
      source: "service",
      package: release.url
        ? {
            url: release.url,
            sha256: release.sha256 || "",
            size: release.sizeBytes || null,
          }
        : null,
    };
  }

  const { manifestUrl } = getUpdateSettings();
  if (!manifestUrl) return { ok: false, error: "NO_MANIFEST_URL" };

  const fetched = await fetchJson(manifestUrl);
  if (!fetched.ok) return fetched;

  const manifest = fetched.json;
  const verified = verifyManifest(manifest);
  if (!verified.ok) return verified;

  const platformKey = currentPlatformKey();
  const platform = manifest.platforms?.[platformKey];
  if (!platform?.url) return { ok: false, error: "NO_PLATFORM_PACKAGE", platformKey };

  const currentVersion = app.getVersion();
  const latestVersion = String(manifest.version || "");
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  return {
    ok: true,
    hasUpdate,
    currentVersion,
    latestVersion,
    force: Boolean(manifest.force),
    notes: manifest.notes || "",
    platformKey,
    package: {
      url: platform.url,
      sha256: platform.sha256 || "",
      size: platform.size || null,
    },
  };
}

async function openUpdateDownload(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: "INVALID_URL" };
  await shell.openExternal(target);
  return { ok: true };
}

function createUpdateManifest(payload, privateKeyPem) {
  const { signDetached } = require("./crypto-signing");
  const manifest = { ...payload };
  delete manifest.signature;
  return {
    ...manifest,
    signature: signDetached(manifest, privateKeyPem),
  };
}

module.exports = {
  getUpdateSettings,
  checkForUpdates,
  openUpdateDownload,
  compareVersions,
  currentPlatformKey,
  createUpdateManifest,
  defaultManifestUrl,
};
