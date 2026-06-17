"use strict";

const net = require("node:net");
const tls = require("node:tls");

class ImapClient {
  constructor(config, options = {}) {
    this.host = config?.imap?.host;
    this.port = Number(config?.imap?.port || 993);
    this.secure = config?.imap?.secure !== false;
    this.account = String(config?.account || "");
    this.secret = String(config?.secret || "");
    this.timeoutMs = Number(options.timeoutMs || 10000);
    this.socket = null;
    this.buffer = "";
    this.tagCounter = 0;
    this.pendingLines = [];
    this.waiters = [];
  }

  async connect() {
    if (!this.host || !this.account || !this.secret) {
      throw new Error("IMAP host, account and secret are required");
    }
    this.socket = await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });
      socket.setEncoding("utf8");
      socket.setTimeout(this.timeoutMs);
      socket.once("error", onError);
      socket.once(this.secure ? "secureConnect" : "connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (err) => this.rejectWaiters(err));
    this.socket.on("timeout", () => this.rejectWaiters(new Error("IMAP connection timed out")));
    await this.readGreeting();
    return this;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.pendingLines.push(line);
    }
  }

  readLine() {
    if (this.pendingLines.length) return Promise.resolve(this.pendingLines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IMAP response timed out")), this.timeoutMs);
      this.waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  rejectWaiters(err) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(err);
  }

  async readGreeting() {
    const greeting = await this.readLine();
    if (!/^\*\s+OK/i.test(greeting)) throw new Error(`IMAP server rejected connection: ${greeting}`);
  }

  nextTag() {
    this.tagCounter += 1;
    return `A${String(this.tagCounter).padStart(4, "0")}`;
  }

  async command(command) {
    const tag = this.nextTag();
    this.socket.write(`${tag} ${command}\r\n`);
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (line.startsWith(`${tag} `)) {
        if (!new RegExp(`^${tag}\\s+OK`, "i").test(line)) {
          throw new Error(`IMAP command failed: ${sanitizeImapLine(line)}`);
        }
        return lines;
      }
    }
  }

  async login() {
    await this.command(`LOGIN ${quoteImapString(this.account)} ${quoteImapString(this.secret)}`);
  }

  async select(mailbox = "INBOX") {
    return this.command(`SELECT ${quoteMailbox(mailbox)}`);
  }

  async search(criteria = "ALL") {
    const lines = await this.command(`UID SEARCH ${criteria || "ALL"}`);
    const searchLine = lines.find((line) => /^\*\s+SEARCH\b/i.test(line)) || "";
    return searchLine
      .replace(/^\*\s+SEARCH\s*/i, "")
      .trim()
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  async fetchEnvelopes(ids) {
    if (!ids.length) return [];
    const lines = await this.command(`UID FETCH ${ids.join(",")} (UID RFC822.SIZE ENVELOPE)`);
    return lines
      .filter((line) => /^\*\s+\d+\s+FETCH\b/i.test(line))
      .map(parseFetchEnvelope)
      .filter(Boolean);
  }

  async logout() {
    if (!this.socket || this.socket.destroyed) return;
    try {
      await this.command("LOGOUT");
    } catch {
      // Closing a mail connection is best-effort after the operation is done.
    } finally {
      this.socket.end();
    }
  }
}

async function withClient(config, options, fn) {
  const client = new ImapClient(config, options);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function testImapConnection(config, options = {}) {
  return withClient(config, options, async (client) => {
    await client.login();
    await client.select("INBOX");
    return { ok: true, mailbox: "INBOX" };
  });
}

async function searchImapMessages(config, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
  const criteria = buildSearchCriteria(options);
  return withClient(config, options, async (client) => {
    await client.login();
    await client.select(options.mailbox || "INBOX");
    const ids = await client.search(criteria);
    const latest = ids.slice(-limit).reverse();
    const messages = await client.fetchEnvelopes(latest);
    const byUid = new Map(messages.map((msg) => [msg.uid, msg]));
    return {
      ok: true,
      mailbox: options.mailbox || "INBOX",
      messages: latest.map((uid) => byUid.get(uid)).filter(Boolean),
    };
  });
}

async function readImapMessage(config, options = {}) {
  const uid = Number(options.uid);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("message uid is required");
  return withClient(config, options, async (client) => {
    await client.login();
    await client.select(options.mailbox || "INBOX");
    const lines = await client.command(`UID FETCH ${uid} (UID RFC822.SIZE ENVELOPE BODY.PEEK[TEXT])`);
    const message = parseFetchMessage(lines);
    if (!message) throw new Error(`message not found: ${uid}`);
    return {
      ok: true,
      mailbox: options.mailbox || "INBOX",
      message,
    };
  });
}

class SmtpClient {
  constructor(config, options = {}) {
    this.host = config?.smtp?.host;
    this.port = Number(config?.smtp?.port || 465);
    this.secure = config?.smtp?.secure !== false;
    this.account = String(config?.account || "");
    this.secret = String(config?.secret || "");
    this.timeoutMs = Number(options.timeoutMs || 10000);
    this.socket = null;
    this.buffer = "";
    this.pendingLines = [];
    this.waiters = [];
  }

  async connect() {
    if (!this.host || !this.account || !this.secret) {
      throw new Error("SMTP host, account and secret are required");
    }
    this.socket = await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });
      socket.setEncoding("utf8");
      socket.setTimeout(this.timeoutMs);
      socket.once("error", onError);
      socket.once(this.secure ? "secureConnect" : "connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (err) => this.rejectWaiters(err));
    this.socket.on("timeout", () => this.rejectWaiters(new Error("SMTP connection timed out")));
    await this.expect([220]);
    return this;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.pendingLines.push(line);
    }
  }

  rejectWaiters(err) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(err);
  }

  readLine() {
    if (this.pendingLines.length) return Promise.resolve(this.pendingLines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP response timed out")), this.timeoutMs);
      this.waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async expect(codes) {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (!/^\d{3}-/.test(line)) {
        const code = Number(line.slice(0, 3));
        if (!codes.includes(code)) throw new Error(`SMTP command failed: ${line}`);
        return lines;
      }
    }
  }

  async command(command, codes = [250]) {
    this.socket.write(`${command}\r\n`);
    return this.expect(codes);
  }

  async auth() {
    await this.command(`EHLO ${smtpDomainFromAccount(this.account)}`, [250]);
    const token = Buffer.from(`\0${this.account}\0${this.secret}`, "utf8").toString("base64");
    await this.command(`AUTH PLAIN ${token}`, [235, 250]);
  }

  async send({ from, to, subject, text }) {
    await this.command(`MAIL FROM:<${from}>`, [250]);
    for (const recipient of to) {
      await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await this.command("DATA", [354]);
    this.socket.write(`${buildMailMessage({ from, to, subject, text })}\r\n.\r\n`);
    await this.expect([250]);
  }

  async quit() {
    if (!this.socket || this.socket.destroyed) return;
    try {
      await this.command("QUIT", [221, 250]);
    } catch {
      // best-effort close
    } finally {
      this.socket.end();
    }
  }
}

async function sendSmtpMessage(config, message = {}, options = {}) {
  if (message.confirmed !== true) {
    throw new Error("Sending mail requires explicit confirmation");
  }
  const to = normalizeRecipients(message.to);
  if (!to.length) throw new Error("at least one recipient is required");
  const subject = String(message.subject || "").trim();
  if (!subject) throw new Error("subject is required");
  const text = String(message.text || "").trim();
  if (!text) throw new Error("message text is required");

  const client = new SmtpClient(config, options);
  await client.connect();
  try {
    await client.auth();
    await client.send({
      from: config.account,
      to,
      subject,
      text,
    });
    return { ok: true, accepted: to };
  } finally {
    await client.quit();
  }
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

function smtpDomainFromAccount(account) {
  return String(account || "").split("@")[1] || "localhost";
}

function buildMailMessage({ from, to, subject, text }) {
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    `Date: ${new Date().toUTCString()}`,
  ];
  return `${headers.join("\r\n")}\r\n\r\n${String(text).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}`;
}

function encodeHeader(value) {
  const text = String(value || "");
  return /^[\x20-\x7E]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function buildSearchCriteria(options = {}) {
  const parts = [];
  if (options.unread) parts.push("UNSEEN");
  if (options.since) parts.push(`SINCE ${formatImapDate(options.since)}`);
  if (options.from) parts.push(`FROM ${quoteImapString(String(options.from).slice(0, 160))}`);
  if (options.subject) parts.push(`SUBJECT ${quoteImapString(String(options.subject).slice(0, 160))}`);
  return parts.length ? parts.join(" ") : "ALL";
}

function formatImapDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid IMAP since date");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function quoteMailbox(value) {
  const mailbox = String(value || "INBOX");
  return /^[A-Za-z0-9_.-]+$/.test(mailbox) ? mailbox : quoteImapString(mailbox);
}

function quoteImapString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sanitizeImapLine(line) {
  return String(line || "").replace(/LOGIN\s+"[^"]*"\s+"[^"]*"/i, 'LOGIN "[redacted]" "[redacted]"');
}

function parseFetchEnvelope(line) {
  const uidMatch = line.match(/\bUID\s+(\d+)/i);
  const sizeMatch = line.match(/\bRFC822\.SIZE\s+(\d+)/i);
  const envIndex = line.toUpperCase().indexOf("ENVELOPE ");
  if (!uidMatch || envIndex < 0) return null;
  const envelope = parseEnvelopeTokens(line.slice(envIndex + "ENVELOPE ".length));
  return {
    uid: Number(uidMatch[1]),
    size: sizeMatch ? Number(sizeMatch[1]) : 0,
    date: cleanAtom(envelope[0]),
    subject: decodeMimeWords(cleanAtom(envelope[1])),
    from: formatAddressList(envelope[2]),
    to: formatAddressList(envelope[5]),
    messageId: cleanAtom(envelope[9]),
  };
}

function parseFetchMessage(lines) {
  const fetchStart = lines.findIndex((line) => /^\*\s+\d+\s+FETCH\b/i.test(line));
  if (fetchStart < 0) return null;
  const envelope = parseFetchEnvelope(lines[fetchStart]);
  if (!envelope) return null;
  const bodyLines = [];
  let inBody = /\bBODY(?:\.PEEK)?\[[^\]]*\]\s+\{\d+\}\s*$/i.test(lines[fetchStart]);
  for (let i = fetchStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^A\d+\s+/i.test(line)) break;
    if (!inBody) {
      inBody = /\bBODY(?:\.PEEK)?\[[^\]]*\]\s+\{\d+\}\s*$/i.test(line);
      continue;
    }
    if (line === ")") break;
    bodyLines.push(line.replace(/\)\s*$/, ""));
  }
  return {
    ...envelope,
    text: normalizeBodyText(bodyLines.join("\n")),
  };
}

function normalizeBodyText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, 120000);
}

function parseEnvelopeTokens(input) {
  const text = String(input || "").trim();
  const parsed = parseValue(text, 0);
  return Array.isArray(parsed.value) ? parsed.value : [];
}

function parseValue(text, start) {
  let i = skipSpaces(text, start);
  if (text[i] === "(") return parseList(text, i);
  if (text[i] === '"') return parseQuoted(text, i);
  return parseAtom(text, i);
}

function parseList(text, start) {
  const out = [];
  let i = start + 1;
  while (i < text.length) {
    i = skipSpaces(text, i);
    if (text[i] === ")") return { value: out, index: i + 1 };
    const parsed = parseValue(text, i);
    out.push(parsed.value);
    i = parsed.index;
  }
  return { value: out, index: i };
}

function parseQuoted(text, start) {
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      value += text[i + 1] || "";
      i += 2;
      continue;
    }
    if (ch === '"') return { value, index: i + 1 };
    value += ch;
    i += 1;
  }
  return { value, index: i };
}

function parseAtom(text, start) {
  let i = start;
  while (i < text.length && !/[\s()]/.test(text[i])) i += 1;
  const atom = text.slice(start, i);
  return { value: /^NIL$/i.test(atom) ? "" : atom, index: i };
}

function skipSpaces(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function cleanAtom(value) {
  return value == null ? "" : String(value);
}

function formatAddressList(value) {
  const list = Array.isArray(value?.[0]) ? value : Array.isArray(value) ? [value] : [];
  return list
    .map((entry) => {
      const name = decodeMimeWords(cleanAtom(entry[0]));
      const mailbox = cleanAtom(entry[2]);
      const host = cleanAtom(entry[3]);
      const email = mailbox && host ? `${mailbox}@${host}` : "";
      return name && email ? `${name} <${email}>` : email || name;
    })
    .filter(Boolean)
    .join(", ");
}

function decodeMimeWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([QB])\?([^?]+)\?=/gi, (_m, charset, encoding, body) => {
    try {
      const normalized = encoding.toUpperCase() === "B"
        ? Buffer.from(body, "base64")
        : Buffer.from(body.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
      return normalized.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
    } catch {
      return body;
    }
  });
}

module.exports = {
  testImapConnection,
  searchImapMessages,
  readImapMessage,
  sendSmtpMessage,
  buildSearchCriteria,
};
