// Email autodiscovery: built-in providers, app-password guidance, ISPDB, guess.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { autodiscover, domainOf, parseIspdbXml } = require("../src/main/mail-autoconfig.js");

// --- built-in CN providers, with 授权码 guidance ---
const netease = await autodiscover("alice@163.com");
assert.equal(netease.source, "builtin");
assert.deepEqual(netease.imap, { host: "imap.163.com", port: 993, secure: true });
assert.deepEqual(netease.smtp, { host: "smtp.163.com", port: 465, secure: true });
assert.equal(netease.secretKind, "app-password");
assert.ok(netease.guidance?.text.includes("授权码"), "163 surfaces 授权码 guidance");

const qq = await autodiscover("bob@qq.com");
assert.equal(qq.imap.host, "imap.qq.com");
assert.ok(qq.guidance?.text.includes("授权码"));

// --- OAuth-preferred providers carry a hint ---
assert.equal((await autodiscover("x@gmail.com")).oauthProvider, "gmail");
const outlook = await autodiscover("x@outlook.com");
assert.equal(outlook.oauthProvider, "outlook");
assert.deepEqual(outlook.smtp, { host: "smtp.office365.com", port: 587, secure: false }); // STARTTLS

// --- unknown domain, offline → convention guess ---
const guess = await autodiscover("x@acme-unknown-xyz.com", { online: false });
assert.equal(guess.source, "guess");
assert.deepEqual(guess.imap, { host: "imap.acme-unknown-xyz.com", port: 993, secure: true });

// --- invalid input ---
assert.equal(await autodiscover("notanemail"), null);
assert.equal(await autodiscover(""), null);
assert.equal(domainOf("A.B@Mail.Example.COM"), "mail.example.com");

// --- ISPDB parse ---
const xml = `<clientConfig><emailProvider id="example.com">
  <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
</emailProvider></clientConfig>`;
const parsed = parseIspdbXml(xml);
assert.deepEqual(parsed.imap, { host: "imap.example.com", port: 993, secure: true });
assert.deepEqual(parsed.smtp, { host: "smtp.example.com", port: 587, secure: false });

// --- ISPDB path via mocked fetch (unknown domain falls through to ISPDB) ---
const fetchImpl = async () => ({ ok: true, text: async () => xml });
const ispdb = await autodiscover("x@example.com", { fetchImpl });
assert.equal(ispdb.source, "ispdb");
assert.equal(ispdb.imap.host, "imap.example.com");

console.log("mail-autoconfig: ok");
