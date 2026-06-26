"use strict";

// Main-process auto re-login for the web-system-learning skill (#1b, slice 3).
// When a learned automation's session expires (executor returns stale) and there
// is NO refresh endpoint, but the user stored a credential for the domain, the
// HOST re-logs-in here — in the main process — using the vault password, captures
// the rotated Set-Cookie, and refreshes the storageState so the action can re-run.
//
// SECURITY: the password lives only in this main-process call (passed in from
// web-credential-store.getCredentialWithSecret). It is never written to the
// storageState, the playbook, the executor argv/env, the audit log, or any event.
// Only the resulting session COOKIES are persisted. The executor stays headless
// and credential-free. See [[web-system-executor-reliability]].

function parseSetCookies(res) {
  try {
    if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  } catch {
    /* ignore */
  }
  const single = res.headers.get && res.headers.get("set-cookie");
  return single ? [single] : [];
}

// Set-Cookie strings -> Playwright-storageState cookie records {name,value,domain,path}.
function cookiesFromResponse(res, loginUrl) {
  let host = "";
  try {
    host = new URL(loginUrl).hostname.toLowerCase();
  } catch {
    /* ignore */
  }
  const out = [];
  for (const raw of parseSetCookies(res)) {
    const parts = String(raw).split(";");
    const [namePart, ...valRest] = String(parts[0] || "").split("=");
    const name = String(namePart || "").trim();
    if (!name) continue;
    const attrs = {};
    for (const seg of parts.slice(1)) {
      const eq = seg.indexOf("=");
      if (eq === -1) continue;
      attrs[seg.slice(0, eq).trim().toLowerCase()] = seg.slice(eq + 1).trim();
    }
    out.push({
      name,
      value: valRest.join("=").trim(),
      domain: String(attrs.domain || host || "").replace(/^\./, "").toLowerCase(),
      path: attrs.path || "/",
    });
  }
  return out;
}

// Merge fresh cookies into a storageState object in place (replace by name+domain,
// else append). Returns the count updated.
function mergeCookiesIntoStorageState(storageState, cookies) {
  if (!storageState || typeof storageState !== "object") return 0;
  if (!Array.isArray(storageState.cookies)) storageState.cookies = [];
  let n = 0;
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    const domain = String(c.domain || "").replace(/^\./, "").toLowerCase();
    const existing = storageState.cookies.find(
      (e) => e && e.name === c.name && String(e.domain || "").replace(/^\./, "").toLowerCase() === domain,
    );
    if (existing) {
      existing.value = c.value;
      existing.path = c.path || existing.path || "/";
    } else {
      storageState.cookies.push({ name: c.name, value: c.value, domain, path: c.path || "/" });
    }
    n += 1;
  }
  return n;
}

function buildLoginBody(spec, username, password) {
  const fields = {
    [spec.usernameField || "username"]: username,
    [spec.passwordField || "password"]: password,
    ...(spec.extraFields && typeof spec.extraFields === "object" ? spec.extraFields : {}),
  };
  if (String(spec.contentType || "json").toLowerCase() === "form") {
    return { body: new URLSearchParams(fields).toString(), contentType: "application/x-www-form-urlencoded" };
  }
  return { body: JSON.stringify(fields), contentType: "application/json" };
}

/**
 * Perform an API-style login (username/password -> session cookies). `credential`
 * is the decrypted record from getCredentialWithSecret ({username, password,...}).
 * `spec` describes the learned login request: { url, method?, usernameField?,
 * passwordField?, contentType?, extraFields? } (url defaults to credential.loginUrl).
 * Returns { ok, status, cookies }. FAIL-SAFE: any error -> { ok:false }, so the
 * caller falls back to today's "relearn / ask user" behavior. Form/JS logins that
 * need a real browser are out of scope here (handled by the capture flow).
 */
async function reloginViaApi(credential, spec = {}, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  try {
    const url = String(spec.url || credential?.loginUrl || "");
    const username = String(credential?.username || "");
    const password = String(credential?.password || "");
    if (!url || !username || !password) return { ok: false, status: 0, cookies: [] };
    const method = String(spec.method || "POST").toUpperCase();
    const { body, contentType } = buildLoginBody(spec, username, password);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(spec.timeoutMs || 30000));
    let res;
    try {
      res = await doFetch(url, { method, headers: { "content-type": contentType }, body, redirect: "follow", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, status: res.status, cookies: [] };
    return { ok: true, status: res.status, cookies: cookiesFromResponse(res, url) };
  } catch {
    return { ok: false, status: 0, cookies: [] }; // fail-safe
  }
}

module.exports = {
  reloginViaApi,
  cookiesFromResponse,
  mergeCookiesIntoStorageState,
  buildLoginBody,
};
