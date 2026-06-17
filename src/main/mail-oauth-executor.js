"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/oauth/callback";

function providerConfig(provider, tenantId = "") {
  if (provider === "gmail") {
    return {
      provider,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      defaultScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
      ],
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    };
  }
  if (provider === "outlook" || provider === "microsoft-365") {
    const tenant = String(tenantId || "common").trim() || "common";
    return {
      provider,
      authUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      defaultScopes: ["offline_access", "Mail.Read", "Mail.ReadWrite", "Mail.Send"],
      extraAuthParams: {},
    };
  }
  throw new Error(`OAuth provider is not supported: ${provider}`);
}

function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildAuthorizationUrl(account, { redirectUri, state, challenge } = {}) {
  const cfg = providerConfig(account.provider, account.oauth?.tenantId);
  const clientId = String(account.oauth?.clientId || "").trim();
  if (!clientId) throw new Error("OAuth Client ID is required");
  const scopes = Array.isArray(account.oauth?.scopes) && account.oauth.scopes.length
    ? account.oauth.scopes
    : cfg.defaultScopes;
  const url = new URL(cfg.authUrl);
  const params = {
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...cfg.extraAuthParams,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

async function exchangeOAuthCode(account, { code, redirectUri, verifier, fetchImpl = fetch } = {}) {
  const cfg = providerConfig(account.provider, account.oauth?.tenantId);
  const clientId = String(account.oauth?.clientId || "").trim();
  if (!clientId) throw new Error("OAuth Client ID is required");
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const response = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error_description || json.error || `OAuth token exchange failed: ${response.status}`);
  }
  return normalizeTokenSet(json);
}

async function refreshOAuthToken(account, { fetchImpl = fetch } = {}) {
  const refreshToken = String(account.token?.refreshToken || "").trim();
  if (!refreshToken) throw new Error("OAuth refresh token is missing");
  const cfg = providerConfig(account.provider, account.oauth?.tenantId);
  const clientId = String(account.oauth?.clientId || "").trim();
  if (!clientId) throw new Error("OAuth Client ID is required");
  const scopes = Array.isArray(account.oauth?.scopes) && account.oauth.scopes.length
    ? account.oauth.scopes
    : cfg.defaultScopes;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });
  const response = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error_description || json.error || `OAuth token refresh failed: ${response.status}`);
  }
  return {
    ...normalizeTokenSet({ ...json, refresh_token: json.refresh_token || refreshToken }),
    refreshToken: json.refresh_token || refreshToken,
  };
}

function normalizeTokenSet(json) {
  const expiresIn = Number(json.expires_in || 3600);
  return {
    accessToken: String(json.access_token || ""),
    refreshToken: String(json.refresh_token || ""),
    tokenType: String(json.token_type || "Bearer"),
    scope: String(json.scope || ""),
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  };
}

async function startOAuthLoopback(account, { timeoutMs = 180000, openExternal = defaultOpenExternal } = {}) {
  const state = base64Url(crypto.randomBytes(18));
  const pkce = createPkcePair();

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer();
    const timer = setTimeout(() => finish(new Error("OAuth authorization timed out")), timeoutMs);

    function finish(err, token) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => {});
      if (err) reject(err);
      else resolve(token);
    }

    server.on("request", async (req, res) => {
      try {
        const url = new URL(req.url || "/", `http://${LOOPBACK_HOST}`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end("Not found");
          return;
        }
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400).end("Invalid OAuth state");
          finish(new Error("Invalid OAuth state"));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400).end("Authorization failed");
          finish(new Error(url.searchParams.get("error_description") || error));
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400).end("Missing authorization code");
          finish(new Error("Missing authorization code"));
          return;
        }
        const redirectUri = redirectUriFor(server.address().port);
        const token = await exchangeOAuthCode(account, { code, redirectUri, verifier: pkce.verifier });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset=\"utf-8\"><title>Lily Workbench</title><body>Authorization complete. You can close this window.</body>");
        finish(null, token);
      } catch (err) {
        res.writeHead(500).end("Authorization failed");
        finish(err);
      }
    });

    server.once("error", finish);
    server.listen(0, LOOPBACK_HOST, async () => {
      try {
        const redirectUri = redirectUriFor(server.address().port);
        const url = buildAuthorizationUrl(account, {
          redirectUri,
          state,
          challenge: pkce.challenge,
        });
        await openExternal(url);
      } catch (err) {
        finish(err);
      }
    });
  });
}

function redirectUriFor(port) {
  return `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
}

function defaultOpenExternal(url) {
  return require("electron").shell.openExternal(url);
}

module.exports = {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeOAuthCode,
  providerConfig,
  redirectUriFor,
  refreshOAuthToken,
  startOAuthLoopback,
};
