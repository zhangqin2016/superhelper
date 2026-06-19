"use strict";

/**
 * Provider-agnostic mail action dispatch — the single place that turns a
 * (mailStore, action, payload) into a result, routing IMAP/SMTP accounts to the
 * imapflow/nodemailer executor and OAuth accounts to the provider APIs.
 *
 * Shared by the HTTP connector bridge and the mail MCP server so both speak to
 * exactly the same logic (no duplicated provider branching).
 */

const {
  testImapConnection,
  searchImapMessages,
  readImapMessage,
  sendSmtpMessage,
} = require("./mail-imap-smtp-executor");
const { searchOAuthMessages, readOAuthMessage, sendOAuthMessage } = require("./mail-oauth-api");

// OAuth executors may return a refreshed token; persist it and strip it from the
// result so it never leaks to the model/agent.
function withoutInternalToken(result, mailStore, account) {
  if (result?.refreshedToken) mailStore.saveOAuthToken(account.id, result.refreshedToken);
  const copy = { ...(result || {}) };
  delete copy.refreshedToken;
  return copy;
}

async function runMailAction(mailStore, action, payload = {}) {
  const account = mailStore.getAccountWithSecret(String(payload.accountId || payload.id || ""));
  if (!account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
  try {
    if (account.provider === "imap-smtp") {
      if (action === "test") return await testImapConnection(account);
      if (action === "search") return await searchImapMessages(account, payload.query || {});
      if (action === "read") return await readImapMessage(account, payload.query || {});
      if (action === "send") {
        return await sendSmtpMessage(account, { ...(payload.message || {}), confirmed: payload.confirmed === true });
      }
    } else {
      if (action === "test") return { ok: true, provider: account.provider, status: account.status };
      if (action === "search") {
        return withoutInternalToken(await searchOAuthMessages(account, payload.query || {}), mailStore, account);
      }
      if (action === "read") {
        return withoutInternalToken(await readOAuthMessage(account, payload.query || {}), mailStore, account);
      }
      if (action === "send") {
        return withoutInternalToken(
          await sendOAuthMessage(account, { ...(payload.message || {}), confirmed: payload.confirmed === true }),
          mailStore,
          account,
        );
      }
    }
    return { ok: false, error: "UNSUPPORTED_ACTION" };
  } catch (err) {
    return { ok: false, error: `${String(action).toUpperCase()}_FAILED`, message: err?.message || String(err) };
  }
}

module.exports = { runMailAction, withoutInternalToken };
