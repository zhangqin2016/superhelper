"use strict";

const { ipcMain } = require("electron");
const { createConnectorStore } = require("./connector-store");
const { createMailAccountStore } = require("./mail-accounts");
const {
  testImapConnection,
  searchImapMessages,
  readImapMessage,
  sendSmtpMessage,
} = require("./mail-imap-smtp-executor");
const { startOAuthLoopback } = require("./mail-oauth-executor");
const { searchOAuthMessages, readOAuthMessage, sendOAuthMessage } = require("./mail-oauth-api");
const { autodiscover } = require("./mail-autoconfig");

function registerConnectorHandlers() {
  const connectorStore = createConnectorStore();
  const mailStore = createMailAccountStore();

  ipcMain.handle("connectors:list-playbooks", () => ({
    ok: true,
    playbooks: connectorStore.listPlaybooksPublic(),
  }));

  ipcMain.handle("connectors:save-playbook", (_event, payload) => {
    try {
      return { ok: true, playbook: connectorStore.savePlaybook(payload || {}) };
    } catch (err) {
      return { ok: false, error: "INVALID_PLAYBOOK", message: err?.message || String(err) };
    }
  });

  ipcMain.handle("connectors:remove-playbook", (_event, id) => ({
    ok: connectorStore.removePlaybook(String(id || "")),
  }));

  ipcMain.handle("mail-accounts:list", () => ({
    ok: true,
    accounts: mailStore.listAccountsPublic(),
  }));

  // Foolproof add-flow: caller passes only an email; we return ready-to-use
  // IMAP/SMTP settings + how to get an app-password, so no host/port is typed.
  ipcMain.handle("mail-accounts:autodiscover", async (_event, email) => {
    try {
      const config = await autodiscover(String(email || ""));
      if (!config) return { ok: false, error: "INVALID_EMAIL" };
      return { ok: true, config };
    } catch (err) {
      return { ok: false, error: "AUTODISCOVER_FAILED", message: err?.message || String(err) };
    }
  });

  ipcMain.handle("mail-accounts:save", (_event, payload) => {
    try {
      return { ok: true, account: mailStore.saveAccount(payload || {}) };
    } catch (err) {
      return { ok: false, error: "INVALID_ACCOUNT", message: err?.message || String(err) };
    }
  });

  ipcMain.handle("mail-accounts:remove", (_event, id) => ({
    ok: mailStore.removeAccount(String(id || "")),
    accounts: mailStore.listAccountsPublic(),
  }));

  ipcMain.handle("mail-accounts:test", async (_event, id) => {
    const account = mailStore.getAccountWithSecret(String(id || ""));
    if (!account) return { ok: false, error: "NOT_FOUND" };
    if (account.provider !== "imap-smtp") {
      return {
        ok: false,
        error: "OAUTH_NOT_CONNECTED",
        message: "OAuth provider is configured but not connected yet.",
      };
    }
    try {
      const result = await testImapConnection(account);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: "CONNECTION_FAILED", message: err?.message || String(err) };
    }
  });

  ipcMain.handle("mail-accounts:oauth-start", async (_event, id) => {
    const account = mailStore.getAccountWithSecret(String(id || ""));
    if (!account) return { ok: false, error: "NOT_FOUND" };
    if (account.authType !== "oauth2") return { ok: false, error: "NOT_OAUTH_ACCOUNT" };
    if (!account.oauth?.clientId) {
      return { ok: false, error: "OAUTH_NOT_CONFIGURED", message: "OAuth Client ID is required." };
    }
    try {
      const token = await startOAuthLoopback(account);
      const updated = mailStore.saveOAuthToken(account.id, token);
      return { ok: true, account: updated };
    } catch (err) {
      return { ok: false, error: "OAUTH_FAILED", message: err?.message || String(err) };
    }
  });

  ipcMain.handle("mail-accounts:search", async (_event, payload) => {
    const account = mailStore.getAccountWithSecret(String(payload?.id || ""));
    if (!account) return { ok: false, error: "NOT_FOUND" };
    try {
      if (account.provider === "imap-smtp") {
        return await searchImapMessages(account, payload?.query || {});
      }
      const result = await searchOAuthMessages(account, payload?.query || {});
      persistRefreshedToken(mailStore, account, result);
      return withoutInternalToken(result);
    } catch (err) {
      return { ok: false, error: "SEARCH_FAILED", message: err?.message || String(err) };
    }
  });

  ipcMain.handle("mail-accounts:read", async (_event, payload) => {
    const account = mailStore.getAccountWithSecret(String(payload?.id || ""));
    if (!account) return { ok: false, error: "NOT_FOUND" };
    try {
      if (account.provider === "imap-smtp") {
        return await readImapMessage(account, payload?.query || {});
      }
      const result = await readOAuthMessage(account, payload?.query || {});
      persistRefreshedToken(mailStore, account, result);
      return withoutInternalToken(result);
    } catch (err) {
      return { ok: false, error: "READ_FAILED", message: err?.message || String(err) };
    }
  });

  ipcMain.handle("mail-accounts:send", async (_event, payload) => {
    const account = mailStore.getAccountWithSecret(String(payload?.id || ""));
    if (!account) return { ok: false, error: "NOT_FOUND" };
    try {
      const message = {
        ...(payload?.message || {}),
        confirmed: payload?.confirmed === true,
      };
      if (account.provider === "imap-smtp") return await sendSmtpMessage(account, message);
      const result = await sendOAuthMessage(account, message);
      persistRefreshedToken(mailStore, account, result);
      return withoutInternalToken(result);
    } catch (err) {
      return { ok: false, error: "SEND_FAILED", message: err?.message || String(err) };
    }
  });
}

function persistRefreshedToken(mailStore, account, result) {
  if (result?.refreshedToken) mailStore.saveOAuthToken(account.id, result.refreshedToken);
}

function withoutInternalToken(result) {
  const copy = { ...(result || {}) };
  delete copy.refreshedToken;
  return copy;
}

module.exports = { registerConnectorHandlers };
