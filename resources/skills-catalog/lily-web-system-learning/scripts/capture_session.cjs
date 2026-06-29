#!/usr/bin/env node
"use strict";

/**
 * One-time login capture. Open a real (headful) browser using a persistent,
 * per-system Lily profile, let the user log in, then save the logged-in session
 * (Playwright storageState) to a stable local file. Every later
 * scan/discover/execute call reuses it via --storage-state, so API actions run
 * with no browser at all while manual recapture still gets the same profile.
 *
 * Security: the session file and browser profile can hold cookies/tokens. They
 * are stored under the app's userData (NOT in the skill directory and NOT in the
 * workspace), protected with local filesystem permissions where available, and
 * are never bundled into a shared/exported workspace. We never ask for or store
 * the password itself — the user types it into the real browser.
 *
 * The browser capture needs Playwright; the path/allowlist/login-signal logic is
 * pure and unit-tested.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeHost, isUrlAllowed } = require("./discover_contracts.cjs");

const DEFAULT_TIMEOUT_MS = 300000; // 5 min for a human to log in
const POLL_MS = 1000;
const STORAGE_AUTH_KEY_RE = /(token|auth|session|jwt|access|refresh|csrf|xsrf|user|account|profile)/i;

function slugifySystem(value) {
  return String(value || "system")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "system";
}

/** Stable per-system session path under userData (local-only, never exported). */
function sessionStorePath(systemId, userDataDir) {
  const base = userDataDir || process.env.LILY_USER_DATA_DIR || path.join(os.tmpdir(), "lily-userdata");
  return path.join(base, "web-sessions", `${slugifySystem(systemId)}.json`);
}

/** Stable per-system browser profile under userData (local-only, never exported). */
function profileStorePath(systemId, userDataDir) {
  const base = userDataDir || process.env.LILY_USER_DATA_DIR || path.join(os.tmpdir(), "lily-userdata");
  return path.join(base, "web-profiles", slugifySystem(systemId));
}

function sessionInfo(file) {
  try {
    const stat = fs.statSync(file);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const signals = authSignalsFromStorageState(state);
    return { exists: true, ...signals, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return { exists: false, cookieCount: 0, localStorageCount: 0, sessionStorageCount: 0, authSignalCount: 0, ageMs: Infinity };
  }
}

function localStorageEntriesFromState(state) {
  const entries = [];
  for (const origin of state?.origins || []) {
    for (const item of origin?.localStorage || []) {
      if (!item?.name || item.value === undefined) continue;
      entries.push({ origin: origin.origin || "", name: item.name, value: String(item.value) });
    }
  }
  return entries;
}

function sessionStorageEntriesFromState(state) {
  const entries = [];
  for (const origin of state?.lilySessionStorage || []) {
    for (const item of origin?.sessionStorage || []) {
      if (!item?.name || item.value === undefined) continue;
      entries.push({ origin: origin.origin || "", name: item.name, value: String(item.value) });
    }
  }
  return entries;
}

function authLikeStorageEntry(entry = {}) {
  const key = String(entry.name || "");
  const value = String(entry.value || "");
  if (!value) return false;
  if (STORAGE_AUTH_KEY_RE.test(key)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)) return true;
  return value.length >= 24 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function authSignalsFromStorageState(state = {}) {
  const cookieCount = Array.isArray(state.cookies) ? state.cookies.length : 0;
  const localStorage = localStorageEntriesFromState(state);
  const sessionStorage = sessionStorageEntriesFromState(state);
  const authStorageCount = [...localStorage, ...sessionStorage].filter(authLikeStorageEntry).length;
  return {
    cookieCount,
    localStorageCount: localStorage.length,
    sessionStorageCount: sessionStorage.length,
    authSignalCount: cookieCount + authStorageCount,
  };
}

/**
 * Decide whether login has completed, from the current URL + captured cookies.
 * Precise signals (successUrlContains / sessionCookie) win; otherwise heuristic:
 * a cookie exists and either the user left an explicit login page, or the
 * current URL does not look like a login/sign-in page. This avoids hanging when
 * the configured entry URL is also the logged-in app shell.
 */
function looksLikeLoginUrl(value) {
  try {
    const parsed = new URL(value);
    return /(?:^|[/_-])(login|signin|sign-in|auth|sso)(?:$|[/_.-])/i.test(parsed.pathname);
  } catch {
    return /(?:login|signin|sign-in|auth|sso)/i.test(String(value || ""));
  }
}

function loginComplete({ url, loginUrl, cookies, storageState, opts = {} }) {
  const cookieList = Array.isArray(cookies) ? cookies : [];
  if (opts.sessionCookie) {
    return cookieList.some((c) => c && c.name === opts.sessionCookie && c.value);
  }
  if (opts.successUrlContains) {
    return String(url || "").includes(opts.successUrlContains);
  }
  const signals = authSignalsFromStorageState({
    cookies: cookieList,
    origins: storageState?.origins || [],
    lilySessionStorage: storageState?.lilySessionStorage || [],
  });
  if (signals.authSignalCount <= 0) return false;
  // Heuristic: have a cookie AND either left the login URL, or the current URL
  // is an already-authenticated app shell at the configured entry URL.
  const leftLogin = Boolean(loginUrl) && String(url || "") !== String(loginUrl);
  return leftLogin || !looksLikeLoginUrl(url);
}

function originAllowed(origin, allowedDomains) {
  return isUrlAllowed(origin, allowedDomains);
}

async function captureBrowserStorage(page, allowedDomains = []) {
  let origin = "";
  try {
    origin = page.url() ? new URL(page.url()).origin : "";
  } catch {
    origin = "";
  }
  if (!origin || !originAllowed(origin, allowedDomains)) return null;
  const stores = await page.evaluate(() => {
    const read = (storage) => {
      const items = [];
      for (let i = 0; i < storage.length; i += 1) {
        const name = storage.key(i);
        if (!name) continue;
        items.push({ name, value: storage.getItem(name) || "" });
      }
      return items;
    };
    return {
      localStorage: read(window.localStorage),
      sessionStorage: read(window.sessionStorage),
    };
  }).catch(() => ({ localStorage: [], sessionStorage: [] }));
  return { origin, ...stores };
}

function mergeCapturedStorage(state, captured, allowedDomains = []) {
  const next = {
    ...state,
    origins: Array.isArray(state.origins) ? [...state.origins] : [],
  };
  if (!captured?.origin || !originAllowed(captured.origin, allowedDomains)) return next;
  if (Array.isArray(captured.localStorage) && captured.localStorage.length) {
    const existing = next.origins.find((item) => item?.origin === captured.origin);
    if (existing) existing.localStorage = captured.localStorage;
    else next.origins.push({ origin: captured.origin, localStorage: captured.localStorage });
  }
  if (Array.isArray(captured.sessionStorage) && captured.sessionStorage.length) {
    next.lilySessionStorage = (Array.isArray(next.lilySessionStorage) ? next.lilySessionStorage : [])
      .filter((item) => item?.origin !== captured.origin);
    next.lilySessionStorage.push({ origin: captured.origin, sessionStorage: captured.sessionStorage });
  }
  return next;
}

function writeSessionFileSecure(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    /* best-effort on platforms without posix perms */
  }
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

function parseArgs(argv) {
  const args = {
    baseUrl: "",
    loginUrl: "",
    systemId: "",
    out: "",
    profileDir: "",
    allowDomains: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    successUrlContains: "",
    sessionCookie: "",
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--login-url") args.loginUrl = argv[++i];
    else if (arg === "--system-id") args.systemId = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--profile-dir") args.profileDir = argv[++i];
    else if (arg === "--allow-domain") args.allowDomains.push(normalizeHost(argv[++i]));
    else if (arg === "--allowlist") args.allowDomains.push(...String(argv[++i] || "").split(",").map(normalizeHost).filter(Boolean));
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (arg === "--success-url-contains") args.successUrlContains = argv[++i];
    else if (arg === "--session-cookie") args.sessionCookie = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node capture_session.cjs --base-url <url> --system-id <id> --allow-domain <host> [--login-url <url>] [--out <file>] [--profile-dir <dir>] [--success-url-contains <str>] [--session-cookie <name>] [--timeout-ms <ms>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.baseUrl) throw new Error("Missing --base-url");
  if (!args.systemId) throw new Error("Missing --system-id");
  if (!args.allowDomains.length) args.allowDomains = [normalizeHost(args.baseUrl)];
  if (!args.loginUrl) args.loginUrl = args.baseUrl;
  if (!args.out) args.out = sessionStorePath(args.systemId);
  if (!args.profileDir) args.profileDir = profileStorePath(args.systemId);
  if (!isUrlAllowed(args.loginUrl, args.allowDomains)) {
    throw new Error(`login URL host is not in the allowlist: ${args.loginUrl}`);
  }
  return args;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// If the user stored a login for this site, the MAIN process (connector bridge)
// can log in on our behalf and write the session file — so the user does NOT have
// to log in by hand. The password stays in the main process; this script only
// sends the URL + session path and gets back whether a session was written.
// Returns false (→ fall back to the headful manual flow) when there's no bridge,
// no stored credential, or the login needs MFA/SSO that an API login can't do.
async function tryBridgeLogin(args) {
  const base = process.env.LILY_CONNECTOR_BRIDGE_URL || "";
  const token = process.env.LILY_CONNECTOR_BRIDGE_TOKEN || "";
  if (!base) return false;
  try {
    const res = await fetch(`${base}/v1/web-system/relogin`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: args.loginUrl || args.baseUrl, sessionStatePath: args.out }),
    });
    const data = await res.json().catch(() => ({}));
    return Boolean(data && data.ok && data.cookiesUpdated > 0);
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.dryRun) {
    emit({ ok: true, dryRun: true, systemId: args.systemId, sessionPath: args.out, profilePath: args.profileDir, loginUrl: args.loginUrl, allowedDomains: args.allowDomains });
    return;
  }

  // Auto-login with a stored credential first; only open the manual browser if
  // that isn't possible (no credential / MFA / SSO).
  if (await tryBridgeLogin(args)) {
    emit({ ok: true, mode: "credential", systemId: args.systemId, sessionPath: args.out, profilePath: args.profileDir, loginUrl: args.loginUrl, allowedDomains: args.allowDomains });
    return;
  }

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (err) {
    emit({ ok: false, code: "PLAYWRIGHT_NODE_MISSING", message: "Browser runtime is not available to capture a login session.", detail: err.message });
    process.exitCode = 3;
    return;
  }

  fs.mkdirSync(args.profileDir, { recursive: true });
  try {
    fs.chmodSync(args.profileDir, 0o700);
  } catch {
    /* best-effort on platforms without posix perms */
  }
  const context = await chromium.launchPersistentContext(args.profileDir, { headless: false });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(args.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const deadline = Date.now() + args.timeoutMs;
    let done = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(POLL_MS);
      let url = "";
      try {
        url = page.url();
      } catch {
        break; // page/window closed by user
      }
      const cookies = await context.cookies().catch(() => []);
      const state = mergeCapturedStorage(
        { cookies, origins: [] },
        await captureBrowserStorage(page, args.allowDomains),
        args.allowDomains,
      );
      if (loginComplete({ url, loginUrl: args.loginUrl, cookies, storageState: state, opts: { successUrlContains: args.successUrlContains, sessionCookie: args.sessionCookie } })) {
        done = true;
        break;
      }
    }
    const state = mergeCapturedStorage(await context.storageState(), await captureBrowserStorage(page, args.allowDomains), args.allowDomains);
    // Drop anything outside the allowlist before persisting.
    state.cookies = (state.cookies || []).filter((c) => isUrlAllowed(`https://${String(c.domain || "").replace(/^\./, "")}/`, args.allowDomains));
    state.origins = (state.origins || []).filter((origin) => originAllowed(origin.origin, args.allowDomains));
    state.lilySessionStorage = (state.lilySessionStorage || []).filter((origin) => originAllowed(origin.origin, args.allowDomains));
    const signals = authSignalsFromStorageState(state);
    if (signals.authSignalCount <= 0) {
      emit({ ok: false, code: "NO_SESSION_CAPTURED", message: "No login session was captured. Log in fully, then retry.", sessionPath: args.out, ...signals });
      process.exitCode = 1;
      return;
    }
    writeSessionFileSecure(args.out, state);
    emit({ ok: true, systemId: args.systemId, sessionPath: args.out, profilePath: args.profileDir, ...signals, completedSignal: done, note: "Reuse this file via --storage-state for scan/discover/execute. Re-run only when a call reports stale/relearn (401/403)." });
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  });
}

module.exports = {
  slugifySystem,
  sessionStorePath,
  profileStorePath,
  sessionInfo,
  loginComplete,
  looksLikeLoginUrl,
  writeSessionFileSecure,
  authSignalsFromStorageState,
  mergeCapturedStorage,
};
