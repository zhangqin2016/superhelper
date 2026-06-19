#!/usr/bin/env node
"use strict";

/**
 * One-time login capture. Open a real (headful) browser once, let the user log
 * in, then save the logged-in session (Playwright storageState) to a stable,
 * per-system, local file. Every later scan/discover/execute call reuses it via
 * --storage-state, so the browser never has to reopen just to authenticate, and
 * API actions run with no browser at all.
 *
 * Security: the session file holds cookies/tokens. It is stored under the app's
 * userData (NOT in the skill directory and NOT in the workspace), written 0600,
 * and is never bundled into a shared/exported workspace. We never ask for or
 * store the password itself — the user types it into the real browser.
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

function sessionInfo(file) {
  try {
    const stat = fs.statSync(file);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const cookieCount = Array.isArray(state.cookies) ? state.cookies.length : 0;
    return { exists: true, cookieCount, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return { exists: false, cookieCount: 0, ageMs: Infinity };
  }
}

/**
 * Decide whether login has completed, from the current URL + captured cookies.
 * Precise signals (successUrlContains / sessionCookie) win; otherwise heuristic:
 * the user has left the login page AND a cookie exists on an allowed domain.
 */
function loginComplete({ url, loginUrl, cookies, opts = {} }) {
  const cookieList = Array.isArray(cookies) ? cookies : [];
  if (opts.sessionCookie) {
    return cookieList.some((c) => c && c.name === opts.sessionCookie && c.value);
  }
  if (opts.successUrlContains) {
    return String(url || "").includes(opts.successUrlContains);
  }
  // Heuristic: have at least one cookie AND we are no longer on the login URL.
  const leftLogin = Boolean(loginUrl) && String(url || "") !== String(loginUrl);
  return cookieList.length > 0 && leftLogin;
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
    else if (arg === "--allow-domain") args.allowDomains.push(normalizeHost(argv[++i]));
    else if (arg === "--allowlist") args.allowDomains.push(...String(argv[++i] || "").split(",").map(normalizeHost).filter(Boolean));
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (arg === "--success-url-contains") args.successUrlContains = argv[++i];
    else if (arg === "--session-cookie") args.sessionCookie = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node capture_session.cjs --base-url <url> --system-id <id> --allow-domain <host> [--login-url <url>] [--out <file>] [--success-url-contains <str>] [--session-cookie <name>] [--timeout-ms <ms>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.baseUrl) throw new Error("Missing --base-url");
  if (!args.systemId) throw new Error("Missing --system-id");
  if (!args.allowDomains.length) args.allowDomains = [normalizeHost(args.baseUrl)];
  if (!args.loginUrl) args.loginUrl = args.baseUrl;
  if (!args.out) args.out = sessionStorePath(args.systemId);
  if (!isUrlAllowed(args.loginUrl, args.allowDomains)) {
    throw new Error(`login URL host is not in the allowlist: ${args.loginUrl}`);
  }
  return args;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.dryRun) {
    emit({ ok: true, dryRun: true, systemId: args.systemId, sessionPath: args.out, loginUrl: args.loginUrl, allowedDomains: args.allowDomains });
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

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
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
      if (loginComplete({ url, loginUrl: args.loginUrl, cookies, opts: { successUrlContains: args.successUrlContains, sessionCookie: args.sessionCookie } })) {
        done = true;
        break;
      }
    }
    const state = await context.storageState();
    // Drop anything outside the allowlist before persisting.
    state.cookies = (state.cookies || []).filter((c) => isUrlAllowed(`https://${String(c.domain || "").replace(/^\./, "")}/`, args.allowDomains));
    if (!state.cookies.length) {
      emit({ ok: false, code: "NO_SESSION_CAPTURED", message: "No session cookies were captured. Log in fully, then retry.", sessionPath: args.out });
      process.exitCode = 1;
      return;
    }
    writeSessionFileSecure(args.out, state);
    emit({ ok: true, systemId: args.systemId, sessionPath: args.out, cookieCount: state.cookies.length, completedSignal: done, note: "Reuse this file via --storage-state for scan/discover/execute. Re-run only when a call reports stale/relearn (401/403)." });
  } finally {
    await context.close();
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  });
}

module.exports = { slugifySystem, sessionStorePath, sessionInfo, loginComplete, writeSessionFileSecure };
