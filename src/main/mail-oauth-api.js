"use strict";

const { refreshOAuthToken } = require("./mail-oauth-executor");

async function searchOAuthMessages(account, query = {}, options = {}) {
  const { account: ready, refreshedToken } = await ensureAccessToken(account, options);
  const result = ready.provider === "gmail"
    ? await searchGmailMessages(ready, query, options)
    : await searchGraphMessages(ready, query, options);
  return { ...result, refreshedToken };
}

async function readOAuthMessage(account, query = {}, options = {}) {
  const { account: ready, refreshedToken } = await ensureAccessToken(account, options);
  const result = ready.provider === "gmail"
    ? await readGmailMessage(ready, query, options)
    : await readGraphMessage(ready, query, options);
  return { ...result, refreshedToken };
}

async function sendOAuthMessage(account, message = {}, options = {}) {
  if (message.confirmed !== true) throw new Error("Sending mail requires explicit confirmation");
  const { account: ready, refreshedToken } = await ensureAccessToken(account, options);
  const result = ready.provider === "gmail"
    ? await sendGmailMessage(ready, message, options)
    : await sendGraphMessage(ready, message, options);
  return { ...result, refreshedToken };
}

async function ensureAccessToken(account, options = {}) {
  if (!account?.token?.accessToken) throw new Error("OAuth account is not authorized");
  const expiresAt = Number(account.token.expiresAt || 0);
  if (expiresAt && expiresAt > Date.now() + 60000) return { account, refreshedToken: null };
  const refreshed = await refreshOAuthToken(account, options);
  return {
    account: { ...account, token: refreshed },
    refreshedToken: refreshed,
  };
}

async function searchGmailMessages(account, query, { fetchImpl = fetch } = {}) {
  const maxResults = clampLimit(query.limit, 10);
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", String(maxResults));
  const q = buildGmailQuery(query);
  if (q) url.searchParams.set("q", q);
  const data = await fetchJson(url, account.token.accessToken, fetchImpl);
  const messages = [];
  for (const item of (data.messages || []).slice(0, maxResults)) {
    const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}`);
    detailUrl.searchParams.set("format", "metadata");
    detailUrl.searchParams.append("metadataHeaders", "Subject");
    detailUrl.searchParams.append("metadataHeaders", "From");
    detailUrl.searchParams.append("metadataHeaders", "To");
    detailUrl.searchParams.append("metadataHeaders", "Date");
    const detail = await fetchJson(detailUrl, account.token.accessToken, fetchImpl);
    messages.push(normalizeGmailMetadata(detail));
  }
  return { ok: true, provider: "gmail", messages };
}

async function readGmailMessage(account, query, { fetchImpl = fetch } = {}) {
  const id = String(query.id || query.uid || "").trim();
  if (!id) throw new Error("message id is required");
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", "full");
  const data = await fetchJson(url, account.token.accessToken, fetchImpl);
  return { ok: true, provider: "gmail", message: normalizeGmailMessage(data) };
}

async function sendGmailMessage(account, message, { fetchImpl = fetch } = {}) {
  const raw = base64Url(buildMailRaw(account.account, message));
  const data = await fetchJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", account.token.accessToken, fetchImpl, {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
  return { ok: true, provider: "gmail", id: data.id || null };
}

async function searchGraphMessages(account, query, { fetchImpl = fetch } = {}) {
  const top = clampLimit(query.limit, 10);
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$top", String(top));
  url.searchParams.set("$select", "id,subject,from,toRecipients,receivedDateTime,bodyPreview");
  if (query.subject) {
    url.searchParams.set("$filter", `contains(subject,'${escapeOData(String(query.subject).slice(0, 120))}')`);
  }
  const data = await fetchJson(url, account.token.accessToken, fetchImpl);
  return {
    ok: true,
    provider: account.provider,
    messages: (data.value || []).map(normalizeGraphMetadata),
  };
}

async function readGraphMessage(account, query, { fetchImpl = fetch } = {}) {
  const id = String(query.id || query.uid || "").trim();
  if (!id) throw new Error("message id is required");
  const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("$select", "id,subject,from,toRecipients,receivedDateTime,body,bodyPreview");
  const data = await fetchJson(url, account.token.accessToken, fetchImpl);
  return { ok: true, provider: account.provider, message: normalizeGraphMessage(data) };
}

async function sendGraphMessage(account, message, { fetchImpl = fetch } = {}) {
  const toRecipients = normalizeRecipients(message.to).map((address) => ({
    emailAddress: { address },
  }));
  if (!toRecipients.length) throw new Error("at least one recipient is required");
  const subject = String(message.subject || "").trim();
  const text = String(message.text || "").trim();
  if (!subject) throw new Error("subject is required");
  if (!text) throw new Error("message text is required");
  await fetchJson("https://graph.microsoft.com/v1.0/me/sendMail", account.token.accessToken, fetchImpl, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: text },
        toRecipients,
      },
      saveToSentItems: true,
    }),
    allowEmpty: true,
  });
  return { ok: true, provider: account.provider, accepted: toRecipients.map((item) => item.emailAddress.address) };
}

async function fetchJson(url, accessToken, fetchImpl, options = {}) {
  const response = await fetchImpl(String(url), {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
  });
  if (options.allowEmpty && response.status === 202) return {};
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error?.message || json.error_description || json.error || `Mail API failed: ${response.status}`);
  }
  return json;
}

function normalizeGmailMetadata(data) {
  const headers = gmailHeaders(data);
  return {
    id: data.id,
    threadId: data.threadId || "",
    subject: headers.subject || "",
    from: headers.from || "",
    to: headers.to || "",
    date: headers.date || "",
    snippet: data.snippet || "",
  };
}

function normalizeGmailMessage(data) {
  return {
    ...normalizeGmailMetadata(data),
    text: extractGmailText(data.payload),
  };
}

function gmailHeaders(data) {
  const headers = data?.payload?.headers || [];
  const out = {};
  for (const header of headers) {
    const key = String(header.name || "").toLowerCase();
    if (["subject", "from", "to", "date"].includes(key)) out[key] = String(header.value || "");
  }
  return out;
}

function extractGmailText(part) {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts || []) {
    const text = extractGmailText(child);
    if (text) return text;
  }
  return "";
}

function normalizeGraphMetadata(data) {
  return {
    id: data.id,
    subject: data.subject || "",
    from: data.from?.emailAddress?.address || data.from?.emailAddress?.name || "",
    to: (data.toRecipients || []).map((item) => item.emailAddress?.address).filter(Boolean).join(", "),
    date: data.receivedDateTime || "",
    snippet: data.bodyPreview || "",
  };
}

function normalizeGraphMessage(data) {
  return {
    ...normalizeGraphMetadata(data),
    text: stripHtml(data.body?.content || data.bodyPreview || ""),
  };
}

function buildGmailQuery(query = {}) {
  const parts = [];
  if (query.unread) parts.push("is:unread");
  if (query.from) parts.push(`from:${String(query.from).slice(0, 160)}`);
  if (query.subject) parts.push(`subject:${String(query.subject).slice(0, 160)}`);
  if (query.text) parts.push(String(query.text).slice(0, 240));
  return parts.join(" ");
}

function buildMailRaw(from, message) {
  const to = normalizeRecipients(message.to);
  if (!to.length) throw new Error("at least one recipient is required");
  const subject = String(message.subject || "").trim();
  const text = String(message.text || "").trim();
  if (!subject) throw new Error("subject is required");
  if (!text) throw new Error("message text is required");
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
}

function normalizeRecipients(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return values
    .map((item) => String(item || "").trim())
    .map((item) => item.match(/<([^>]+)>/)?.[1]?.trim() || item)
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
}

function clampLimit(value, fallback) {
  return Math.max(1, Math.min(50, Number(value || fallback)));
}

function base64Url(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(text) {
  return Buffer.from(String(text || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function escapeOData(value) {
  return String(value || "").replace(/'/g, "''");
}

module.exports = {
  searchOAuthMessages,
  readOAuthMessage,
  sendOAuthMessage,
};
