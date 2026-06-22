#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { createMailAccountStore } = require("../src/main/mail-accounts.js");
const {
  testImapConnection,
  searchImapMessages,
  readImapMessage,
  sendSmtpMessage,
} = require("../src/main/mail-imap-smtp-executor.js");
const {
  buildAuthorizationUrl,
  exchangeOAuthCode,
  redirectUriFor,
} = require("../src/main/mail-oauth-executor.js");
const {
  searchOAuthMessages,
  readOAuthMessage,
  sendOAuthMessage,
} = require("../src/main/mail-oauth-api.js");

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mail-accounts-"));
  const store = createMailAccountStore({ filePath: path.join(tmp, "mail-accounts.json") });
  const saved = store.saveAccount({
    provider: "imap-smtp",
    label: "Ops Inbox",
    account: "ops@example.com",
    secret: "app-password",
    imap: { host: "imap.example.com", port: 993, secure: true },
    smtp: { host: "smtp.example.com", port: 465, secure: true },
  });
  assert.equal(saved.provider, "imap-smtp");
  assert.equal(saved.secretSet, true);

  const raw = fs.readFileSync(path.join(tmp, "mail-accounts.json"), "utf8");
  assert.equal(raw.includes("app-password"), false, "mail account secret must not be stored in plaintext");

  const listed = store.listAccountsPublic();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].secretSet, true);
  assert.equal(Object.hasOwn(listed[0], "secret"), false);

  const full = store.getAccountWithSecret(saved.id);
  assert.equal(full.secret, "app-password");

  const oauth = store.saveAccount({
    provider: "gmail",
    label: "Gmail",
    account: "user@gmail.com",
    oauth: { clientId: "", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
  });
  assert.equal(oauth.status, "needs-config");
  assert.equal(oauth.authType, "oauth2");

  const oauthConfigured = store.saveAccount({
    id: oauth.id,
    provider: "gmail",
    label: "Gmail",
    account: "user@gmail.com",
    oauth: { clientId: "google-client", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
  });
  assert.equal(oauthConfigured.status, "configured");
  const connected = store.saveOAuthToken(oauth.id, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3600000,
  });
  assert.equal(connected.status, "connected");
  const connectedRaw = fs.readFileSync(path.join(tmp, "mail-accounts.json"), "utf8");
  assert.equal(connectedRaw.includes("refresh-token"), false, "OAuth refresh token must not be stored in plaintext");
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const account = {
    provider: "gmail",
    account: "user@gmail.com",
    oauth: { clientId: "google-client", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
  };
  const url = new URL(buildAuthorizationUrl(account, {
    redirectUri: redirectUriFor(43123),
    state: "state",
    challenge: "challenge",
  }));
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "google-client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");

  const token = await exchangeOAuthCode(account, {
    code: "oauth-code",
    redirectUri: redirectUriFor(43123),
    verifier: "verifier",
    fetchImpl: async (_url, init) => {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code_verifier"), "verifier");
      return {
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      };
    },
  });
  assert.equal(token.accessToken, "access-token");
  assert.equal(token.refreshToken, "refresh-token");
}

{
  const account = {
    provider: "gmail",
    account: "user@gmail.com",
    token: { accessToken: "access-token", refreshToken: "refresh-token", expiresAt: Date.now() + 3600000 },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.match(init.headers.authorization, /^Bearer access-token$/);
    if (url.includes("/messages?")) {
      return okJson({ messages: [{ id: "m1" }] });
    }
    if (url.includes("/messages/m1") && url.includes("format=metadata")) {
      return okJson({
        id: "m1",
        threadId: "t1",
        snippet: "hello snippet",
        payload: { headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "a@example.com" }] },
      });
    }
    if (url.includes("/messages/m1") && url.includes("format=full")) {
      return okJson({
        id: "m1",
        payload: {
          headers: [{ name: "Subject", value: "Hello" }],
          parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Gmail body", "utf8").toString("base64url") } }],
        },
      });
    }
    if (url.endsWith("/messages/send")) return okJson({ id: "sent-id" });
    throw new Error(`unexpected gmail url: ${url}`);
  };
  const search = await searchOAuthMessages(account, { limit: 1 }, { fetchImpl });
  assert.equal(search.messages[0].subject, "Hello");
  const read = await readOAuthMessage(account, { id: "m1" }, { fetchImpl });
  assert.equal(read.message.text, "Gmail body");
  await assert.rejects(() => sendOAuthMessage(account, { to: "a@example.com", subject: "S", text: "T" }, { fetchImpl }), /explicit confirmation/);
  const sent = await sendOAuthMessage(account, { to: "a@example.com", subject: "S", text: "T", confirmed: true }, { fetchImpl });
  assert.equal(sent.id, "sent-id");
  assert.equal(calls.length >= 4, true);
}

{
  const account = {
    provider: "microsoft-365",
    account: "user@example.com",
    token: { accessToken: "access-token", refreshToken: "refresh-token", expiresAt: Date.now() + 3600000 },
  };
  const fetchImpl = async (url, init) => {
    assert.match(init.headers.authorization, /^Bearer access-token$/);
    if (url.includes("/me/messages?") && !url.includes("/me/messages/g1")) {
      return okJson({ value: [{ id: "g1", subject: "Graph", from: { emailAddress: { address: "boss@example.com" } } }] });
    }
    if (url.includes("/me/messages/g1")) {
      return okJson({ id: "g1", subject: "Graph", body: { content: "<p>Graph body</p>" } });
    }
    if (url.endsWith("/me/sendMail")) return { ok: true, status: 202, json: async () => ({}) };
    throw new Error(`unexpected graph url: ${url}`);
  };
  const search = await searchOAuthMessages(account, { limit: 1 }, { fetchImpl });
  assert.equal(search.messages[0].subject, "Graph");
  const read = await readOAuthMessage(account, { id: "g1" }, { fetchImpl });
  assert.equal(read.message.text, "Graph body");
  const sent = await sendOAuthMessage(account, { to: "boss@example.com", subject: "S", text: "T", confirmed: true }, { fetchImpl });
  assert.deepEqual(sent.accepted, ["boss@example.com"]);
}

{
  const server = await startFakeImapServer();
  try {
    const config = {
      account: "ops@example.com",
      secret: "app-password",
      imap: { host: "127.0.0.1", port: server.port, secure: false },
    };
    const tested = await testImapConnection(config, { timeoutMs: 1500 });
    assert.equal(tested.ok, true);
    assert.equal(tested.mailbox, "INBOX");

    const messages = await searchImapMessages(config, { limit: 2, timeoutMs: 1500 });
    assert.equal(messages.ok, true);
    assert.equal(messages.messages.length, 2);
    assert.equal(messages.messages[0].subject, "Second update");
    assert.equal(messages.messages[1].from, "Alice <alice@example.com>");

    const read = await readImapMessage(config, { uid: 2, timeoutMs: 1500 });
    assert.equal(read.ok, true);
    assert.equal(read.message.uid, 2);
    assert.equal(read.message.subject, "Second update");
    assert.match(read.message.text, /Body for second update/);
  } finally {
    await server.close();
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mail-bridge-"));
  const previousUserData = process.env.LILY_USER_DATA_DIR;
  process.env.LILY_USER_DATA_DIR = tmp;
  const bridgeModule = require("../src/main/connector-bridge.js");
  const server = await startFakeImapServer();
  try {
    const store = createMailAccountStore({ filePath: path.join(tmp, "mail-accounts.json") });
    const account = store.saveAccount({
      provider: "imap-smtp",
      label: "Bridge Inbox",
      account: "bridge@example.com",
      secret: "app-password",
      imap: { host: "127.0.0.1", port: server.port, secure: false },
      smtp: { host: "127.0.0.1", port: 2525, secure: false },
    });
    const bridge = await bridgeModule.ensureConnectorBridgeStarted({ mailStore: store });
    const unauthorized = await fetch(`${bridge.url}/v1/mail/accounts`, { method: "POST" });
    assert.equal(unauthorized.status, 401, "connector bridge must reject missing bearer token");

    const search = await postBridge(bridge, "/v1/mail/search", { accountId: account.id, query: { limit: 1, timeoutMs: 1500 } });
    assert.equal(search.ok, true);
    assert.equal(search.messages.length, 1);

    const read = await postBridge(bridge, "/v1/mail/read", { accountId: account.id, query: { uid: 2, timeoutMs: 1500 } });
    assert.equal(read.ok, true);
    assert.match(read.message.text, /Body for second update/);

    const env = { ...process.env, ...bridgeModule.getConnectorBridgeEnvSync() };
    const script = path.join(process.cwd(), "resources/skills-catalog/lily-mail-assistant/scripts/mail_connector_action.cjs");
    const listed = await runNodeScript(script, ["accounts"], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).accounts[0].id, account.id);
  } finally {
    bridgeModule.stopConnectorBridge();
    await server.close();
    if (previousUserData === undefined) delete process.env.LILY_USER_DATA_DIR;
    else process.env.LILY_USER_DATA_DIR = previousUserData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const server = await startFakeSmtpServer();
  try {
    const config = {
      account: "ops@example.com",
      secret: "app-password",
      smtp: { host: "127.0.0.1", port: server.port, secure: false },
    };
    await assert.rejects(
      () => sendSmtpMessage(config, {
        to: ["alice@example.com"],
        subject: "Draft",
        text: "hello",
      }),
      /explicit confirmation/,
    );
    const sent = await sendSmtpMessage(config, {
      to: ["alice@example.com"],
      subject: "Draft",
      text: "hello",
      confirmed: true,
    }, { timeoutMs: 1500 });
    assert.equal(sent.ok, true);
    assert.equal(sent.accepted.length, 1);
    assert.equal(server.messages.length, 1);
    assert.match(server.messages[0], /Subject: Draft/);
  } finally {
    await server.close();
  }
}

console.log("mail-executors: ok");

function okJson(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  };
}

async function postBridge(bridge, route, payload) {
  const response = await fetch(`${bridge.url}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function runNodeScript(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function startFakeImapServer() {
  const messages = new Map([
    [1, {
      from: "Alice <alice@example.com>",
      to: "Ops <ops@example.com>",
      subject: "First update",
      date: "Mon, 15 Jun 2026 10:00:00 +0000",
      messageId: "<first@example.com>",
      size: 120,
    }],
    [2, {
      from: "Bob <bob@example.com>",
      to: "Ops <ops@example.com>",
      subject: "Second update",
      date: "Mon, 15 Jun 2026 11:00:00 +0000",
      messageId: "<second@example.com>",
      size: 180,
    }],
  ]);

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("* OK fake imap ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleLine(socket, line, messages);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function startFakeSmtpServer() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake smtp ready\r\n");
    let buffer = "";
    let dataMode = false;
    let current = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (dataMode) {
          if (line === ".") {
            messages.push(current);
            current = "";
            dataMode = false;
            socket.write("250 queued\r\n");
          } else {
            current += `${line}\r\n`;
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (upper.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (upper.startsWith("MAIL FROM")) socket.write("250 sender ok\r\n");
        else if (upper.startsWith("RCPT TO")) socket.write("250 recipient ok\r\n");
        else if (upper === "DATA") {
          dataMode = true;
          socket.write("354 end with dot\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        messages,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function handleLine(socket, line, messages) {
  const [tag, command] = line.split(/\s+/, 2);
  const upper = String(command || "").toUpperCase();
  if (upper === "CAPABILITY") {
    // No AUTH=PLAIN: imapflow then authenticates with the plain LOGIN command
    // (handled below) instead of AUTHENTICATE PLAIN's SASL continuation flow.
    socket.write("* CAPABILITY IMAP4rev1\r\n");
    socket.write(`${tag} OK capability done\r\n`);
    return;
  }
  if (upper === "LOGIN") {
    socket.write(`${tag} OK login done\r\n`);
    return;
  }
  if (upper === "LIST") {
    socket.write('* LIST () "/" "INBOX"\r\n');
    socket.write(`${tag} OK list done\r\n`);
    return;
  }
  if (upper === "SELECT") {
    socket.write(`* ${messages.size} EXISTS\r\n`);
    socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
    return;
  }
  if (upper === "UID") {
    if (/\bSEARCH\b/i.test(line)) {
      socket.write(`* SEARCH ${Array.from(messages.keys()).join(" ")}\r\n`);
      socket.write(`${tag} OK search done\r\n`);
      return;
    }
    const match = line.match(/\bFETCH\s+([0-9,]+)\s+/i);
    if (match) {
      for (const id of match[1].split(",").map((value) => Number(value.trim())).filter(Boolean)) {
        const msg = messages.get(id);
        if (!msg) continue;
        if (/\bBODY(\.PEEK)?\[\]/i.test(line)) {
          // fetchOne({ source: true }) requests the full RFC822 body — return a
          // complete message so simpleParser can read subject + text.
          const source = [
            `From: ${msg.from}`,
            `To: ${msg.to}`,
            `Subject: ${msg.subject}`,
            `Date: ${msg.date}`,
            `Message-ID: ${msg.messageId}`,
            "",
            `Body for ${msg.subject.toLowerCase()}`,
            "",
          ].join("\r\n");
          const n = Buffer.byteLength(source, "utf8");
          socket.write(`* ${id} FETCH (UID ${id} RFC822.SIZE ${msg.size} BODY[] {${n}}\r\n${source})\r\n`);
        } else if (/\bBODY\.PEEK\[TEXT\]/i.test(line)) {
          socket.write(`* ${id} FETCH (UID ${id} RFC822.SIZE ${msg.size} ENVELOPE ("${msg.date}" "${msg.subject}" (("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) (("Ops" NIL "ops" "example.com")) NIL NIL NIL "${msg.messageId}") BODY[TEXT] {24}\r\n`);
          socket.write(`Body for second update\r\n)\r\n`);
        } else {
          socket.write(`* ${id} FETCH (UID ${id} RFC822.SIZE ${msg.size} ENVELOPE ("${msg.date}" "${msg.subject}" (("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) (("Ops" NIL "ops" "example.com")) NIL NIL NIL "${msg.messageId}"))\r\n`);
        }
      }
      socket.write(`${tag} OK fetch done\r\n`);
      return;
    }
  }
  if (upper === "LOGOUT") {
    socket.write("* BYE logout\r\n");
    socket.write(`${tag} OK logout done\r\n`);
    socket.end();
    return;
  }
  // Anything else imapflow probes during its handshake (LSUB, ENABLE, ID,
  // NAMESPACE, …) gets a benign OK so the connection completes — the commands
  // that need untagged data (LIST/SELECT/SEARCH/FETCH) are handled explicitly.
  socket.write(`${tag || "x"} OK ignored\r\n`);
}
