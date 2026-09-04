"use strict";

/**
 * The account-authentication calls of the service client.
 *
 * Extracted from service-client.js, which was at its line ratchet, when the
 * enterprise-issued login (name + password) joined the SMS one. These six calls
 * are one concern — getting a session and giving it back — and share exactly
 * two dependencies, which are injected so this file has no knowledge of how the
 * transport or the device identity work.
 *
 * @param {{ serviceFetch: Function, devicePayload: Function, getDeviceId: Function }} deps
 */
function createAccountAuthClient({ serviceFetch, devicePayload, getDeviceId }) {
  async function sendSmsCode(phone) {
    return serviceFetch("/api/auth/sms/send", {
      method: "POST",
      body: JSON.stringify({
        phone: String(phone || "").trim(),
        purpose: "login",
        deviceId: getDeviceId(),
      }),
    });
  }

  async function loginWithSms({ phone, code } = {}) {
    return serviceFetch("/api/auth/sms/login", {
      method: "POST",
      body: JSON.stringify({
        ...devicePayload(),
        phone: String(phone || "").trim(),
        code: String(code || "").trim(),
      }),
    });
  }

  /** Enterprise-issued account: the company created the login, not the phone. */
  async function loginWithPassword({ loginName, password } = {}) {
    return serviceFetch("/api/auth/password/login", {
      method: "POST",
      body: JSON.stringify({
        ...devicePayload(),
        loginName: String(loginName || "").trim(),
        password: String(password || ""),
      }),
    });
  }

  async function changeAccountPassword({ accessToken, currentPassword, newPassword } = {}) {
    return serviceFetch("/api/auth/password/change", {
      method: "POST",
      headers: { Authorization: `Bearer ${String(accessToken || "").trim()}` },
      body: JSON.stringify({
        ...devicePayload(),
        currentPassword: String(currentPassword || ""),
        newPassword: String(newPassword || ""),
      }),
    });
  }

  async function refreshAccountAccessToken(refreshToken) {
    return serviceFetch("/api/auth/session/refresh", {
      method: "POST",
      body: JSON.stringify({
        ...devicePayload(),
        refreshToken: String(refreshToken || "").trim(),
      }),
    });
  }

  async function logoutAccount(refreshToken) {
    return serviceFetch("/api/auth/session/logout", {
      method: "POST",
      body: JSON.stringify({
        refreshToken: String(refreshToken || "").trim(),
      }),
    });
  }

  return { sendSmsCode, loginWithSms, loginWithPassword, changeAccountPassword, refreshAccountAccessToken, logoutAccount };
}

module.exports = { createAccountAuthClient };
