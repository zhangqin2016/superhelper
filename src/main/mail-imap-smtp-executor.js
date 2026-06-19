"use strict";

/**
 * IMAP/SMTP for self-hosted / password (or app-password) mail accounts.
 *
 * Built on battle-tested libraries instead of hand-rolled net/tls protocol code:
 *   - imapflow   : IMAP client (charset-aware envelopes, proper protocol handling)
 *   - mailparser : full MIME parsing (multipart, transfer-encoding, GBK/Big5/…)
 *   - nodemailer : SMTP send (correct MIME, header encoding, attachments)
 *
 * This fixes the previous hand-rolled implementation's gaps: garbled CJK
 * subjects/bodies, multipart/HTML shown as raw MIME, and no attachment support.
 *
 * Public contract (unchanged — callers in connector-bridge/ipc-connectors rely
 * on it): config = { account, secret, imap:{host,port,secure}, smtp:{host,port,secure} }.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const { simpleParser } = require("mailparser");

const SEARCH_MAX = 50;
const ATTACHMENT_MAX = 20;

// Turn the tool's attachment list (local file paths) into nodemailer attachment
// specs. nodemailer streams each file from disk — no base64 round-trips through
// MCP. Missing files fail loud rather than silently sending without them.
function buildAttachments(list) {
  if (list == null) return [];
  const items = Array.isArray(list) ? list : [list];
  if (items.length > ATTACHMENT_MAX) {
    throw new Error(`too many attachments (max ${ATTACHMENT_MAX})`);
  }
  return items.map((item) => {
    const filePath = typeof item === "string" ? item : String(item?.path || "");
    if (!filePath) throw new Error("attachment path is required");
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error(`attachment not found: ${filePath}`);
    }
    if (!stat.isFile()) throw new Error(`attachment is not a file: ${filePath}`);
    const filename = (typeof item === "object" && item?.filename) || path.basename(filePath);
    return { filename, path: filePath };
  });
}

function formatAddrs(list) {
  if (!Array.isArray(list)) return "";
  return list
    .map((a) => (a?.name ? `${a.name} <${a.address}>` : a?.address || ""))
    .filter(Boolean)
    .join(", ");
}

function isoDate(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function imapConfig(config, options = {}) {
  if (!config?.imap?.host || !config?.account || !config?.secret) {
    throw new Error("IMAP host, account and secret are required");
  }
  return {
    host: config.imap.host,
    port: Number(config.imap.port || 993),
    secure: config.imap.secure !== false,
    auth: { user: config.account, pass: config.secret },
    logger: false,
    // Plain (secure:false) connections upgrade via STARTTLS when offered.
    tls: { servername: config.imap.host },
    socketTimeout: Number(options.timeoutMs) || 30_000,
  };
}

async function withClient(config, options, fn) {
  const client = new ImapFlow(imapConfig(config, options));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close?.();
    }
  }
}

// Map our query options onto an imapflow search object (charset handled by lib).
function buildSearchQuery(options = {}) {
  const query = {};
  if (options.unread) query.seen = false;
  if (options.since) query.since = new Date(options.since);
  if (options.from) query.from = String(options.from).slice(0, 160);
  if (options.subject) query.subject = String(options.subject).slice(0, 160);
  return Object.keys(query).length ? query : { all: true };
}

function normalizeRecipients(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return values
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/<([^>]+)>/);
      return match ? match[1].trim() : item;
    })
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
}

async function testImapConnection(config, options = {}) {
  return withClient(config, options, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
    return { ok: true, mailbox: "INBOX" };
  });
}

async function searchImapMessages(config, options = {}) {
  const limit = Math.max(1, Math.min(SEARCH_MAX, Number(options.limit || 10)));
  const mailbox = options.mailbox || "INBOX";
  return withClient(config, options, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uids = (await client.search(buildSearchQuery(options), { uid: true })) || [];
      const latest = uids.slice(-limit).reverse(); // newest first
      const messages = [];
      if (latest.length) {
        for await (const msg of client.fetch(latest, { uid: true, envelope: true, size: true }, { uid: true })) {
          const env = msg.envelope || {};
          messages.push({
            uid: msg.uid,
            size: msg.size || 0,
            date: isoDate(env.date),
            subject: env.subject || "",
            from: formatAddrs(env.from),
            to: formatAddrs(env.to),
            messageId: env.messageId || "",
          });
        }
        // imapflow may stream out of request order; restore newest-first.
        messages.sort((a, b) => latest.indexOf(a.uid) - latest.indexOf(b.uid));
      }
      return { ok: true, mailbox, messages };
    } finally {
      lock.release();
    }
  });
}

async function readImapMessage(config, options = {}) {
  const uid = Number(options.uid);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("message uid is required");
  const mailbox = options.mailbox || "INBOX";
  return withClient(config, options, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const fetched = await client.fetchOne(uid, { uid: true, source: true, size: true }, { uid: true });
      if (!fetched?.source) throw new Error(`message not found: ${uid}`);
      const parsed = await simpleParser(fetched.source);
      return {
        ok: true,
        mailbox,
        message: {
          uid,
          size: fetched.size || 0,
          date: isoDate(parsed.date),
          subject: parsed.subject || "",
          from: parsed.from?.text || "",
          to: parsed.to?.text || "",
          messageId: parsed.messageId || "",
          text: parsed.text || "",
          html: typeof parsed.html === "string" ? parsed.html : "",
          attachments: (parsed.attachments || []).map((a) => ({
            filename: a.filename || "",
            contentType: a.contentType || "",
            size: a.size || 0,
          })),
        },
      };
    } finally {
      lock.release();
    }
  });
}

async function sendSmtpMessage(config, message = {}, options = {}) {
  if (message.confirmed !== true) {
    throw new Error("Sending mail requires explicit confirmation");
  }
  if (!config?.smtp?.host || !config?.account || !config?.secret) {
    throw new Error("SMTP host, account and secret are required");
  }
  const to = normalizeRecipients(message.to);
  if (!to.length) throw new Error("at least one recipient is required");
  const cc = normalizeRecipients(message.cc);
  const bcc = normalizeRecipients(message.bcc);
  const subject = String(message.subject || "").trim();
  if (!subject) throw new Error("subject is required");
  const text = String(message.text || "").trim();
  const html = typeof message.html === "string" ? message.html : undefined;
  if (!text && !html) throw new Error("message text is required");
  const attachments = buildAttachments(message.attachments);

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: Number(config.smtp.port || 465),
    secure: config.smtp.secure !== false,
    auth: { user: config.account, pass: config.secret },
    connectionTimeout: Number(options.timeoutMs) || 30_000,
  });
  try {
    const info = await transport.sendMail({
      from: config.account,
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      text: text || undefined,
      html,
      attachments: attachments.length ? attachments : undefined,
    });
    return { ok: true, accepted: info.accepted?.length ? info.accepted : to, messageId: info.messageId || "" };
  } finally {
    transport.close?.();
  }
}

module.exports = {
  testImapConnection,
  searchImapMessages,
  readImapMessage,
  sendSmtpMessage,
};
