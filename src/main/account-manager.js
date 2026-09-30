"use strict";

const fs = require("node:fs");
const jsonFile = require("./json-file");
const path = require("node:path");
const { userDataPath } = require("./config");
const serviceClient = require("./service-client");
const organizationIdentity = require("./organization-identity");

const ACCOUNT_FILE = "account-state.json";
const ACCOUNT_ACCESS_MAX_STALE_MS = 24 * 60 * 60 * 1000;

let accessToken = "";
let accessExpiresAt = 0;
let accessUserId = "";
let accountGeneration = 0;
let byokMemo = null; // see byokDecision()
const secretStorage = require("./secret-storage");
const unprotectText = (record) => secretStorage.unprotectSecret(record);

/**
 * The refresh token for disk, or null when the OS cannot protect it and
 * plaintext was not opted into. The session still works for this run (the
 * access token is in memory); the next launch asks for a login again. That is
 * the honest outcome — a token written in Base64 would only look kept.
 */
function protectRefreshToken(refreshToken) {
  try {
    return secretStorage.protectSecret(refreshToken);
  } catch (error) {
    if (!secretStorage.isSecretStorageRefusal(error)) throw error;
    console.warn("[account] session not persisted: secure secret storage unavailable (LILY_ALLOW_PLAINTEXT_SECRETS=1 to opt into plaintext)");
    return null;
  }
}

function statePath() {
  return userDataPath(ACCOUNT_FILE);
}

function readState() {
  try {
    const file = statePath();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const file = statePath();
  jsonFile.writeJson(file, state);
  byokMemo = null;
}

function tokenFresh() {
  return accessToken && accessExpiresAt && Date.now() + 30_000 < accessExpiresAt;
}

/**
 * A refresh failure is only fatal when the server EXPLICITLY rejects the
 * refresh token (401/403/404 with a body). Network timeouts, 5xx and 429 are
 * transient: logging the user out for those turns "my wifi hiccupped" into
 * "I was silently signed out and must re-login by SMS" — the single most
 * confusing "activated but unusable" report.
 */
function isTransientRefreshFailure(result = {}) {
  const status = Number(result.status || 0);
  if (!status) return true; // network/timeout — server never answered
  return status === 408 || status === 429 || status >= 500;
}

async function ensureAccessToken({ forceRefresh = false } = {}) {
  const state = readState();
  const ownerId = String(state.user?.id || "");
  if (!forceRefresh && tokenFresh() && accessUserId === ownerId) return { ok: true, accessToken };
  const generation = accountGeneration;
  const refreshToken = unprotectText(state.refreshToken);
  if (!refreshToken) return { ok: false, error: "ACCOUNT_LOGIN_REQUIRED" };
  const refreshed = await serviceClient.refreshAccountAccessToken(refreshToken);
  const current = readState();
  if (generation !== accountGeneration || String(current.user?.id || "") !== ownerId || unprotectText(current.refreshToken) !== refreshToken) {
    return { ok: false, error: "ACCOUNT_SESSION_CHANGED" };
  }
  if (!refreshed.ok) {
    if (isTransientRefreshFailure(refreshed)) {
      return { ok: false, error: refreshed.error || "SERVICE_REQUEST_FAILED", transient: true };
    }
    clearAccount();
    return refreshed;
  }
  accessToken = refreshed.json?.accessToken || "";
  accessUserId = ownerId;
  accessExpiresAt = Date.now() + Number(refreshed.json?.expiresIn || 0) * 1000;
  if (!accessToken) return { ok: false, error: "INVALID_ACCOUNT_TOKEN" };
  return { ok: true, accessToken };
}

function accountStatus() {
  const state = readState();
  const refreshToken = unprotectText(state.refreshToken);
  return {
    ok: true,
    loggedIn: Boolean(refreshToken && state.user?.id),
    user: state.user || null,
    entitlements: state.entitlements || null,
    entitlementsRefreshedAt: state.entitlementsRefreshedAt || state.loggedInAt || "",
  };
}

function parseTime(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function entitlementsUsable(entitlements = {}) {
  if (!entitlements || typeof entitlements !== "object") return false;
  if (entitlements.usable === false) return false;
  if (Number(entitlements.tokenBalance || 0) > 0) return true;
  if (Number(entitlements.imageGenerationsRemaining || 0) > 0) return true;
  if (Number(entitlements.videoGenerationsRemaining || 0) > 0) return true;
  const membershipExpiresAt = parseTime(entitlements.membershipExpiresAt);
  if (membershipExpiresAt && membershipExpiresAt > Date.now()) return true;
  return Boolean(entitlements.usable);
}

function accountAccessStatus() {
  const status = accountStatus();
  if (!status.loggedIn) {
    return { ok: true, usable: false, error: "ACCOUNT_LOGIN_REQUIRED", accountStatus: status };
  }
  const refreshedAtMs = parseTime(status.entitlementsRefreshedAt);
  if (!refreshedAtMs || Date.now() - refreshedAtMs > ACCOUNT_ACCESS_MAX_STALE_MS) {
    return { ok: true, usable: false, error: "ACCOUNT_ENTITLEMENTS_STALE", accountStatus: status };
  }
  if (!entitlementsUsable(status.entitlements)) {
    return { ok: true, usable: false, error: "ACCOUNT_ENTITLEMENTS_INSUFFICIENT", accountStatus: status };
  }
  return { ok: true, usable: true, accountStatus: status };
}

/**
 * The BYOK plan-gate verdict for the signed-in account (byok-policy decides).
 * Read on hot paths (active-model resolution), so it is memoized briefly and
 * dropped whenever account state is written — a refreshed entitlement (e.g. a
 * plan just bought) takes effect on the next read, no restart. Any failure to
 * read the inputs is fail-open: allowed.
 */
const BYOK_MEMO_MS = 3_000;

function byokDecision() {
  const { decideByok } = require("./byok-policy");
  if (byokMemo && Date.now() - byokMemo.at < BYOK_MEMO_MS) return byokMemo.decision;
  let decision;
  try {
    const entitlements = readState().entitlements || null;
    // Only an explicit refusal needs the (costlier) session and licence checks.
    if (entitlements?.byokAllowed !== false) {
      decision = decideByok({ entitlements });
    } else {
      let licenseValid = false;
      try {
        const license = require("./license-manager").getLicenseStatus();
        licenseValid = Boolean(license?.activated && license?.valid);
      } catch { licenseValid = false; }
      decision = decideByok({ loggedIn: accountStatus().loggedIn, entitlements, licenseValid });
    }
  } catch {
    decision = decideByok({});
  }
  byokMemo = { at: Date.now(), decision };
  return decision;
}

async function updateProfile({ displayName } = {}) {
  const generation = accountGeneration;
  const ownerId = readState().user?.id;
  const token = await ensureAccessToken();
  if (!token.ok) return token;
  if (generation !== accountGeneration) return { ok: false, error: "ACCOUNT_SESSION_CHANGED" };
  const result = await serviceClient.updateAccountProfile({ accessToken: token.accessToken, displayName });
  const current = readState();
  if (generation !== accountGeneration || current.user?.id !== ownerId) return { ok: false, error: "ACCOUNT_SESSION_CHANGED" };
  if (!result.ok) return result;
  if (typeof result.json?.displayName !== "string") return { ok: false, error: "INVALID_PROFILE_RESPONSE" };
  writeState({ ...current, user: { ...current.user, displayName: result.json.displayName } });
  return { ok: true, displayName: result.json.displayName };
}

async function sendSmsCode(phone) {
  return serviceClient.sendSmsCode(phone);
}

async function loginWithSms({ phone, code } = {}) {
  const generation = ++accountGeneration;
  const result = await serviceClient.loginWithSms({ phone, code });
  if (generation !== accountGeneration) return { ok: false, error: "ACCOUNT_SESSION_CHANGED" };
  if (!result.ok) return result;
  const refreshToken = result.json?.refreshToken || "";
  accessToken = result.json?.accessToken || "";
  accessUserId = String(result.json?.user?.id || "");
  accessExpiresAt = Date.now() + Number(result.json?.expiresIn || 0) * 1000;
  writeState({
    user: result.json?.user || null,
    entitlements: result.json?.entitlements || null,
    refreshToken: protectRefreshToken(refreshToken),
    loggedInAt: new Date().toISOString(),
    entitlementsRefreshedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    user: result.json?.user || null,
    entitlements: result.json?.entitlements || null,
  };
}

/** Same session handling as SMS login; only the credential differs. */
async function loginWithPassword({ loginName, password } = {}) {
  const generation = ++accountGeneration;
  const result = await serviceClient.loginWithPassword({ loginName, password });
  if (generation !== accountGeneration) return { ok: false, error: "ACCOUNT_SESSION_CHANGED" };
  if (!result.ok) return result;
  const refreshToken = result.json?.refreshToken || "";
  accessToken = result.json?.accessToken || "";
  accessUserId = String(result.json?.user?.id || "");
  accessExpiresAt = Date.now() + Number(result.json?.expiresIn || 0) * 1000;
  writeState({
    user: result.json?.user || null,
    entitlements: result.json?.entitlements || null,
    refreshToken: protectRefreshToken(refreshToken),
    loggedInAt: new Date().toISOString(),
    entitlementsRefreshedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    user: result.json?.user || null,
    entitlements: result.json?.entitlements || null,
    passwordMustChange: Boolean(result.json?.user?.passwordMustChange),
  };
}

async function changePassword({ currentPassword, newPassword } = {}) {
  const token = await ensureAccessToken();
  if (!token.ok) return token;
  const result = await serviceClient.changeAccountPassword({ accessToken: token.accessToken, currentPassword, newPassword });
  if (!result.ok) return result;
  // The forced-change flag lives on the stored user; clear it so the UI stops asking.
  const state = readState();
  if (state.user) writeState({ ...state, user: { ...state.user, passwordMustChange: false } });
  return { ok: true };
}

async function fetchOrganizations() {
  const token = await ensureAccessToken();
  if (!token.ok) return token;
  const result = await serviceClient.serviceFetch("/api/enterprise/organizations", {
    method: "GET",
    headers: { Authorization: `Bearer ${String(token.accessToken || "").trim()}` },
  });
  if (!result.ok) return result;
  const rows = (Array.isArray(result.json?.organizations) ? result.json.organizations : [])
    .map((row) => ({ ...row, unusableCode: organizationIdentity.organizationUnusableCode(row) }));
  const state = readState();
  // Only a list the server actually returned may move the selection; a failed
  // refresh returned above and proves nothing.
  const decision = organizationIdentity.organizationSelectionDecision({
    currentId: state.currentOrganizationId,
    organizations: rows,
  });
  const next = { ...state, organizations: rows, organizationsRefreshedAt: new Date().toISOString() };
  let selection = decision;
  if (decision.action === "clear") {
    // Gone for this user (removed / left / deleted): the header would only be
    // refused. Clear it and report it — the caller tells the user they are on
    // their personal identity now.
    const previous = (Array.isArray(state.organizations) ? state.organizations : [])
      .find((row) => String(row?.id || "") === decision.organizationId);
    selection = { ...decision, organizationName: String(previous?.name || "") };
    next.currentOrganizationId = "";
    delete next.organizationMe;
  }
  writeState(next);
  const currentOrganizationId = String(next.currentOrganizationId || "").trim();
  let currentOrganizationMe = null;
  if (currentOrganizationId && decision.action === "keep") {
    const detail = await fetchOrganizationMe(currentOrganizationId, token.accessToken);
    currentOrganizationMe = detail.ok ? detail.me : null;
  }
  return { ok: true, organizations: rows, currentOrganizationId, selection, currentOrganizationMe };
}

/**
 * The member's own week in one organization (detail `me`), cached so a weekly
 * limit refusal in chat can name the reset time. Fail-open: no detail, no cache
 * change, no error surfaced.
 */
async function fetchOrganizationMe(organizationId, bearer) {
  const id = String(organizationId || "").trim();
  if (!id) return { ok: false };
  try {
    const result = await serviceClient.serviceFetch(`/api/enterprise/organizations/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${String(bearer || "").trim()}` },
    });
    const me = result?.ok ? result.json?.organization?.me : null;
    if (!me || typeof me !== "object" || me.ok === false) return { ok: false };
    const state = readState();
    if (String(state.currentOrganizationId || "").trim() === id) {
      writeState({ ...state, organizationMe: { ...me, organizationId: id, fetchedAt: new Date().toISOString() } });
    }
    return { ok: true, me };
  } catch {
    return { ok: false };
  }
}

/** Cached `me` for the CURRENT organization only; null otherwise. */
function getCurrentOrganizationMe() {
  const state = readState();
  const id = String(state.currentOrganizationId || "").trim();
  const me = state.organizationMe;
  return id && me && me.organizationId === id ? me : null;
}

/** Current org selection for the model request header; "" = personal path. */
function getCurrentOrganizationId() {
  const state = readState();
  return String(state.currentOrganizationId || "").trim();
}

/** Persist the user's current org selection; "" clears back to personal. */
function setCurrentOrganizationId(organizationId) {
  const state = readState();
  const nextId = String(organizationId || "").trim();
  const next = { ...state, currentOrganizationId: nextId };
  if (state.organizationMe?.organizationId !== nextId) delete next.organizationMe;
  writeState(next);
  return getCurrentOrganizationId();
}

async function refreshEntitlements() {
  const token = await ensureAccessToken();
  if (!token.ok) return token;
  const result = await serviceClient.fetchAccountEntitlements(token.accessToken);
  if (!result.ok) return result;
  const state = readState();
  writeState({
    ...state,
    entitlements: result.json?.entitlements || null,
    entitlementsRefreshedAt: new Date().toISOString(),
  });
  return { ok: true, entitlements: result.json?.entitlements || null };
}

async function createBillingLink() {
  const token = await ensureAccessToken();
  if (!token.ok) return token;
  const result = await serviceClient.createBillingLink(token.accessToken);
  if (!result.ok) return result;
  return {
    ok: true,
    url: result.json?.url || "",
    expiresIn: result.json?.expiresIn || 0,
  };
}

async function accessTokenForService(options) {
  return ensureAccessToken(options);
}

async function logout() {
  const state = readState();
  const refreshToken = unprotectText(state.refreshToken);
  if (refreshToken) await serviceClient.logoutAccount(refreshToken);
  clearAccount();
  return { ok: true };
}

function clearAccount() {
  accountGeneration += 1;
  accessToken = "";
  accessUserId = "";
  accessExpiresAt = 0;
  writeState({});
}
module.exports = {
  updateProfile,
  accountStatus,
  accountAccessStatus,
  byokDecision,
  isTransientRefreshFailure,
  sendSmsCode,
  loginWithSms,
  loginWithPassword,
  changePassword,
  refreshEntitlements,
  fetchOrganizations,
  getCurrentOrganizationId,
  getCurrentOrganizationMe,
  setCurrentOrganizationId,
  createBillingLink,
  accessTokenForService,
  logout,
  clearAccount,
};
