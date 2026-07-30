"use strict";

const crypto = require("node:crypto");

function scopeHash(kind, value) {
  const id = String(value || "").trim();
  if (!id) return null;
  const digest = crypto
    .createHash("sha256")
    .update(`lily-character-worlds|${kind}|${id}`)
    .digest("hex");
  return `profile:${kind}:${digest}`;
}

function ownerScopeFromPrincipal(principal) {
  const value = String(principal || "").trim();
  if (value.startsWith("user:") && value.length > "user:".length) {
    return scopeHash("account", value.slice("user:".length));
  }
  if (value.startsWith("device:") && value.length > "device:".length) {
    return scopeHash("device", value.slice("device:".length));
  }
  return null;
}

function resolveCurrentPrincipal(deps = {}) {
  const accountStatus = typeof deps.accountStatus === "function"
    ? deps.accountStatus
    : () => require("../account-manager").accountStatus();
  const getDeviceId = typeof deps.getDeviceId === "function"
    ? deps.getDeviceId
    : () => require("../service-client").getDeviceId();
  let account;
  try {
    account = accountStatus();
  } catch {
    return null;
  }
  if (account?.loggedIn === true) {
    return account.user?.id ? `user:${account.user.id}` : null;
  }
  if (account?.loggedIn !== false) return null;
  try {
    const deviceId = String(getDeviceId() || "").trim();
    return deviceId ? `device:${deviceId}` : null;
  } catch {
    return null;
  }
}

function resolveCharacterOwnerScope(deps = {}) {
  return ownerScopeFromPrincipal(resolveCurrentPrincipal(deps));
}

module.exports = {
  ownerScopeFromPrincipal,
  resolveCharacterOwnerScope,
  resolveCurrentPrincipal,
  scopeHash,
};
