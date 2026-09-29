#!/usr/bin/env node
// Every code the enterprise server can return has a message in zh, en and ar.
//
// Both consoles used to show raw codes (ORG_OWNER_IMMUTABLE, OWNER_NOT_REGISTERED,
// a Postgres 23505). The codes are read from the SERVER SOURCE, not from a list
// kept here, so a code added later without a message fails this gate by name.
// [gate: enterprise-closed-loop]

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ENTERPRISE_MESSAGE_CODES, enterpriseMessage, enterpriseErrorCode } = await import(path.join(root, "web/lib/enterprise-messages.mjs"));

const sources = [
  "server/src/services/enterprise.js",
  "server/src/services/enterprise-mutations.js",
  "server/src/services/enterprise-accounts.js",
  "server/src/services/enterprise-invitations.js",
  "server/src/services/wallet.js",
  "server/src/services/organization-context.js",
  "server/src/routes/admin/enterprise.js",
  ...fs.readdirSync(path.join(root, "server/src/routes/public")).filter((f) => f.startsWith("enterprise")).map((f) => `server/src/routes/public/${f}`),
];
// Internal reasons that never leave the server as a response code.
const INTERNAL = new Set(["ORG_MISSING"]);
const found = new Set();
for (const file of sources) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const [, code] of text.matchAll(/["'`]((?:ORG|MEMBER|USER|INVALID|INVITE|INVITATION|ACCOUNTS?|LOGIN|WEEKLY|OWNER|GRANT|PASSWORD)_[A-Z_]+)["'`]/g)) {
    if (!INTERNAL.has(code)) found.add(code);
  }
}
assert.ok(found.size >= 40, `the scan must see the enterprise codes (saw ${found.size})`);
const missing = [...found].filter((code) => !ENTERPRISE_MESSAGE_CODES.includes(code));
assert.deepEqual(missing, [], `every enterprise server code needs a message: ${missing.join(", ")}`);

for (const code of ENTERPRISE_MESSAGE_CODES) {
  const texts = ["zh", "en", "ar"].map((locale) => enterpriseMessage(code, locale));
  assert.ok(texts.every((t) => t && !t.includes(code)), `${code} has a real message in zh/en/ar`);
  assert.notEqual(texts[0], texts[1], `${code}: zh is not the English text`);
  assert.notEqual(texts[2], texts[1], `${code}: ar is not the English text`);
}

// The shapes the fetch helpers throw: "CODE", "CODE: detail", an Error.
assert.equal(enterpriseErrorCode(new Error("ORG_LAST_OWNER")), "ORG_LAST_OWNER");
assert.equal(enterpriseErrorCode("LOGIN_NAME_TAKEN: LOGIN_NAME_TAKEN"), "LOGIN_NAME_TAKEN");
assert.equal(enterpriseMessage(new Error("ORG_SUSPENDED"), "en"), "The organization is frozen by the platform. Contact platform support.");
assert.match(enterpriseMessage("SOMETHING_NEW", "zh"), /SOMETHING_NEW/, "an unknown code still says which, rather than nothing");
assert.doesNotMatch(enterpriseMessage("fetch failed", "en"), /undefined/);

console.log(`enterprise messages: ok (${found.size} server codes, ${ENTERPRISE_MESSAGE_CODES.length} messages × 3 languages)`);
