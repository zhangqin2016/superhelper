"use strict";

const fs = require("node:fs");
const path = require("node:path");
const semver = require("semver");
const { app, shell } = require("electron");
const { userDataPath } = require("./config");
const { loadPublicKey } = require("./license-manager");
const { verifyDetached } = require("./crypto-signing");

const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MANIFEST_URL = "https://qny.lanrensoft.cn/app/updates/latest.json";
const DEFAULT_AUTO_UPDATE_BASE_URL = "https://qny.lanrensoft.cn/app/auto-updates";

const PHASE = Object.freeze({
  idle: "idle",
  checking: "checking",
  available: "available",
  downloading: "downloading",
  downloaded: "downloaded",
  restartPending: "restart_pending",
  installing: "installing",
  error: "error",
});

/** @type {{ mainWindow?: import("electron").BrowserWindow | null, runnerPool?: any, sessionManager?: any }} */
let runtimeContext = {};
let updater = null;
let updaterWired = false;
let activeFeedUrl = "";
let downloadReady = false;
let idleInstallTimer = null;
let autoDownloadStartedFor = "";
let updateState = createBaseState();

// Silent auto-update (default on for packaged builds): when a newer version is
// found we download it in the background and let electron-updater install it on
// the next normal quit (autoInstallOnAppQuit) — zero clicks, no forced restart.
// Disable with LILY_UPDATE_SILENT=0 to fall back to the manual download/install
// flow driven from the UI.
function isSilentAutoUpdate() {
  const raw = String(process.env.LILY_UPDATE_SILENT || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

function defaultManifestUrl() {
  return process.env.LILY_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL;
}

function defaultAutoUpdateBaseUrl() {
  return process.env.LILY_AUTO_UPDATE_BASE_URL || DEFAULT_AUTO_UPDATE_BASE_URL;
}

function normalizeUrlBase(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function deriveAutoFeedUrl(platformKey = currentPlatformKey(), channel = "stable") {
  const configured = String(process.env.LILY_AUTO_UPDATE_FEED_URL || "").trim();
  if (configured) return normalizeUrlBase(configured);
  return `${normalizeUrlBase(defaultAutoUpdateBaseUrl())}/${encodeURIComponent(platformKey)}/${encodeURIComponent(channel)}`;
}

// Update feeds and download links may arrive from the service API. Restrict
// them to origins we already trust for updates — a compromised or spoofed
// service response must not be able to redirect the updater elsewhere.
function trustedUpdateOrigins() {
  const origins = new Set();
  const candidates = [
    defaultManifestUrl(),
    defaultAutoUpdateBaseUrl(),
    process.env.LILY_AUTO_UPDATE_FEED_URL,
  ];
  try {
    const svc = require("./service-client").getServiceSettings();
    if (svc?.apiBaseUrl) candidates.push(svc.apiBaseUrl);
  } catch {
    // service client unavailable in some test contexts
  }
  for (const value of candidates) {
    try {
      if (value) origins.add(new URL(String(value)).origin);
    } catch {
      // ignore malformed configured URLs
    }
  }
  return origins;
}

function isTrustedUpdateUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return false;
    return trustedUpdateOrigins().has(parsed.origin);
  } catch {
    return false;
  }
}

function getUpdateSettings() {
  return {
    ok: true,
    manifestUrl: defaultManifestUrl(),
    autoUpdateBaseUrl: defaultAutoUpdateBaseUrl(),
    autoFeedUrl: deriveAutoFeedUrl(),
    configurable: false,
  };
}

// Proper semver ordering (honors pre-release tags like 1.0.0-beta < 1.0.0),
// via the `semver` lib. Parses strict versions when present, coerces loose ones
// (e.g. "v1.2"), and returns 0 on anything unparseable — staying fail-safe like
// the previous hand-rolled split-on-[.-] comparison, but correct.
function compareVersions(a, b) {
  const pa = semver.parse(String(a || "").trim()) || semver.coerce(String(a || "0"));
  const pb = semver.parse(String(b || "").trim()) || semver.coerce(String(b || "0"));
  if (!pa || !pb) return 0;
  return semver.compare(pa, pb);
}

function currentPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function createBaseState() {
  return {
    ok: true,
    phase: PHASE.idle,
    currentVersion: safeAppVersion(),
    latestVersion: safeAppVersion(),
    platformKey: currentPlatformKey(),
    hasUpdate: false,
    source: null,
    package: null,
    notes: "",
    force: false,
    feedUrl: "",
    canAutoInstall: false,
    canManualDownload: false,
    waitingForIdle: false,
    progress: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

function safeAppVersion() {
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}

function setState(patch) {
  updateState = {
    ...updateState,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  broadcastState();
  return getUpdateState();
}

function getUpdateState() {
  return JSON.parse(JSON.stringify(updateState));
}

function sendToRenderer(channel, payload) {
  const win = runtimeContext.mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function broadcastState() {
  sendToRenderer("updates:state", getUpdateState());
}

function configure(ctx = {}) {
  runtimeContext = { ...runtimeContext, ...ctx };
  broadcastState();
}

function getAutoUpdater() {
  if (updater) return updater;
  try {
    updater = require("electron-updater").autoUpdater;
  } catch (err) {
    setState({
      phase: PHASE.error,
      ok: false,
      error: { code: "UPDATER_UNAVAILABLE", detail: err?.message || String(err) },
      canAutoInstall: false,
    });
    return null;
  }
  return updater;
}

function wireAutoUpdater() {
  const instance = getAutoUpdater();
  if (!instance || updaterWired) return instance;
  updaterWired = true;
  instance.autoDownload = false;
  // We publish full NSIS installers for Windows. Keep the client off
  // differential downloads so automatic updates do not depend on optional
  // blockmap metadata being available at the edge.
  instance.disableDifferentialDownload = true;
  // Install a background-downloaded update on the next normal quit (no forced
  // restart). Silent zero-click delivery on Windows; on macOS it also requires
  // a signed + notarized build for Squirrel.Mac to accept the update.
  instance.autoInstallOnAppQuit = true;
  instance.on("checking-for-update", () => {
    setState({ phase: PHASE.checking, error: null, progress: null });
  });
  instance.on("update-available", () => {
    downloadReady = false;
    setState({
      phase: PHASE.available,
      hasUpdate: true,
      canAutoInstall: true,
      error: null,
    });
  });
  instance.on("update-not-available", () => {
    downloadReady = false;
    setState({
      phase: PHASE.idle,
      hasUpdate: false,
      latestVersion: safeAppVersion(),
      canAutoInstall: false,
      progress: null,
      error: null,
    });
  });
  instance.on("download-progress", (progress) => {
    setState({
      phase: PHASE.downloading,
      progress: {
        percent: Number(progress?.percent || 0),
        transferred: Number(progress?.transferred || 0),
        total: Number(progress?.total || 0),
        bytesPerSecond: Number(progress?.bytesPerSecond || 0),
      },
      error: null,
    });
  });
  instance.on("update-downloaded", () => {
    downloadReady = true;
    setState({
      phase: PHASE.downloaded,
      progress: { ...(updateState.progress || {}), percent: 100 },
      waitingForIdle: false,
      canAutoInstall: true,
      error: null,
    });
  });
  instance.on("error", (err) => {
    setState({
      phase: PHASE.error,
      ok: false,
      error: { code: "AUTO_UPDATE_FAILED", detail: err?.message || String(err) },
      canAutoInstall: false,
    });
  });
  return instance;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await require("./proxy-aware-fetch")(url, { signal: controller.signal });
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

async function checkStaticUpdates() {
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
    source: "static",
    feedUrl: manifest.feedUrl || manifest.autoFeedUrl || deriveAutoFeedUrl(platformKey),
    package: {
      url: platform.url,
      sha256: platform.sha256 || "",
      size: platform.size || null,
    },
  };
}

async function checkServiceUpdates() {
  const service = require("./service-client");
  const serviceSettings = service.getServiceSettings();
  if (!serviceSettings.apiBaseUrl) return { ok: false, error: "NO_SERVICE_URL" };
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
    feedUrl: release.feedUrl || deriveAutoFeedUrl(platformKey),
    package: release.url
      ? {
          url: release.url,
          sha256: release.sha256 || "",
          size: release.sizeBytes || null,
        }
      : null,
  };
}

function preferNewerUpdate(primary, fallback) {
  if (primary?.ok && fallback?.ok) {
    if (compareVersions(fallback.latestVersion, primary.latestVersion) > 0) return fallback;
    if (!primary.hasUpdate && fallback.hasUpdate) return fallback;
    return primary;
  }
  if (primary?.ok) return primary;
  if (fallback?.ok) return fallback;
  return primary || fallback || { ok: false, error: "CHECK_FAILED" };
}

async function checkForUpdates() {
  const service = await checkServiceUpdates().catch((error) => ({
    ok: false,
    error: "SERVICE_UPDATE_FAILED",
    detail: error?.message || String(error),
  }));
  const staticManifest = await checkStaticUpdates().catch((error) => ({
    ok: false,
    error: "STATIC_UPDATE_FAILED",
    detail: error?.message || String(error),
  }));
  return preferNewerUpdate(service, staticManifest);
}

async function checkForUpdatesState() {
  setState({
    ok: true,
    phase: PHASE.checking,
    currentVersion: safeAppVersion(),
    platformKey: currentPlatformKey(),
    error: null,
    progress: null,
  });

  const result = await checkForUpdates();
  if (!result?.ok) {
    return setState({
      ok: false,
      phase: PHASE.error,
      hasUpdate: false,
      error: { code: result?.error || "CHECK_FAILED", detail: result?.detail || "" },
      canAutoInstall: false,
    });
  }

  let feedUrl = result.feedUrl || deriveAutoFeedUrl(result.platformKey);
  if (!isTrustedUpdateUrl(feedUrl)) {
    console.warn("[update-manager] untrusted feed url rejected: %s", feedUrl);
    feedUrl = deriveAutoFeedUrl(result.platformKey);
  }
  const next = {
    ok: true,
    // Keep "downloaded" sticky so a periodic re-check doesn't drop a staged
    // update back to "available".
    phase: result.hasUpdate ? (downloadReady ? PHASE.downloaded : PHASE.available) : PHASE.idle,
    hasUpdate: Boolean(result.hasUpdate),
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    platformKey: result.platformKey,
    source: result.source || "static",
    package: result.package || null,
    notes: result.notes || "",
    force: Boolean(result.force),
    feedUrl,
    canAutoInstall: Boolean(result.hasUpdate && feedUrl && app.isPackaged),
    canManualDownload: Boolean(result.package?.url),
    waitingForIdle: false,
    progress: null,
    error: null,
  };
  setState(next);

  if (next.hasUpdate && next.canAutoInstall) {
    const instance = wireAutoUpdater();
    if (instance) {
      activeFeedUrl = feedUrl;
      instance.setFeedURL({ provider: "generic", url: feedUrl });
      // Silent zero-click: download in the background once per discovered
      // version; the staged update installs on the next normal quit.
      if (isSilentAutoUpdate() && !downloadReady && autoDownloadStartedFor !== next.latestVersion) {
        autoDownloadStartedFor = next.latestVersion;
        downloadUpdate().catch((err) => {
          console.warn("[update-manager] silent download failed", err?.message || err);
        });
      }
    }
  }
  return getUpdateState();
}

async function downloadUpdate() {
  if (!updateState.hasUpdate) {
    const checked = await checkForUpdatesState();
    if (!checked.hasUpdate) return checked;
  }
  if (!updateState.canAutoInstall) {
    if (updateState.package?.url) return openUpdateDownload(updateState.package.url);
    return setState({
      phase: PHASE.error,
      ok: false,
      error: { code: "NO_AUTO_UPDATE_FEED", detail: "No automatic update feed is available." },
    });
  }

  const instance = wireAutoUpdater();
  if (!instance) return getUpdateState();
  if (activeFeedUrl !== updateState.feedUrl) {
    activeFeedUrl = updateState.feedUrl;
    instance.setFeedURL({ provider: "generic", url: updateState.feedUrl });
  }
  setState({ phase: PHASE.downloading, progress: { percent: 0 }, error: null });
  try {
    await instance.checkForUpdates();
    await instance.downloadUpdate();
  } catch (err) {
    setState({
      phase: PHASE.available,
      ok: true,
      canAutoInstall: false,
      canManualDownload: Boolean(updateState.package?.url),
      error: { code: "AUTO_FEED_FAILED", detail: err?.message || String(err) },
    });
  }
  return getUpdateState();
}

function hasBusyRunner() {
  const runnerPool = runtimeContext.runnerPool;
  if (!runnerPool?.getSessionIds) return false;
  for (const sessionId of runnerPool.getSessionIds()) {
    if (runnerPool.get(sessionId)?.isBusy?.()) return true;
  }
  return false;
}

function scheduleInstallWhenIdle() {
  if (idleInstallTimer) return;
  idleInstallTimer = setInterval(() => {
    if (hasBusyRunner()) return;
    clearInterval(idleInstallTimer);
    idleInstallTimer = null;
    installUpdate({ force: true }).catch((err) => {
      setState({
        phase: PHASE.error,
        ok: false,
        error: { code: "INSTALL_FAILED", detail: err?.message || String(err) },
      });
    });
  }, 5_000);
}

async function installUpdate(options = {}) {
  if (!downloadReady && updateState.phase !== PHASE.downloaded) {
    return setState({
      phase: PHASE.error,
      ok: false,
      error: { code: "UPDATE_NOT_DOWNLOADED", detail: "Update must be downloaded before installing." },
    });
  }
  if (hasBusyRunner() && !options.force) {
    const state = setState({
      phase: PHASE.restartPending,
      waitingForIdle: true,
      error: null,
    });
    scheduleInstallWhenIdle();
    return state;
  }
  if (idleInstallTimer) {
    clearInterval(idleInstallTimer);
    idleInstallTimer = null;
  }
  const instance = wireAutoUpdater();
  if (!instance) return getUpdateState();
  setState({ phase: PHASE.installing, waitingForIdle: false, error: null });
  try {
    runtimeContext.sessionManager?.saveImmediate?.();
  } catch (err) {
    console.warn("[updates] save before install failed", err?.message || err);
  }
  setTimeout(() => {
    instance.quitAndInstall(true, true);
  }, 150);
  return getUpdateState();
}

async function openUpdateDownload(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: "INVALID_URL" };
  if (!isTrustedUpdateUrl(target)) return { ok: false, error: "UNTRUSTED_DOWNLOAD_ORIGIN" };
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
  isTrustedUpdateUrl,
  trustedUpdateOrigins,
  configure,
  getUpdateSettings,
  getUpdateState,
  checkForUpdates,
  checkForUpdatesState,
  downloadUpdate,
  installUpdate,
  openUpdateDownload,
  compareVersions,
  currentPlatformKey,
  deriveAutoFeedUrl,
  createUpdateManifest,
  defaultManifestUrl,
  defaultAutoUpdateBaseUrl,
};
