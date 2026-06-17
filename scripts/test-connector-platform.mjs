#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  normalizeConnectorManifest,
  normalizeActionSpec,
  normalizePlaybookSpec,
  redactConnectorSecrets,
} = require("../src/main/connector-protocol.js");
const {
  createConnectorStore,
} = require("../src/main/connector-store.js");

{
  const manifest = normalizeConnectorManifest({
    id: "gmail",
    name: "Gmail",
    kind: "mail",
    capabilities: ["mail.search", "mail.read", "mail.draft_reply", "mail.send"],
    auth: { type: "oauth2", secretRefs: ["gmail-refresh-token"] },
  });

  assert.equal(manifest.id, "gmail");
  assert.equal(manifest.kind, "mail");
  assert.deepEqual(manifest.capabilities, ["mail.search", "mail.read", "mail.draft_reply", "mail.send"]);
  assert.equal(manifest.auth.type, "oauth2");
}

assert.throws(
  () => normalizeConnectorManifest({ id: "Bad ID", name: "Bad", kind: "mail", capabilities: ["mail.search"] }),
  /id/,
);

{
  const action = normalizeActionSpec({
    action: "mail.send",
    title: "Send reply",
    risk: "submit",
    confirmation: "review",
    connectorKind: "mail",
  });
  assert.equal(action.action, "mail.send");
  assert.equal(action.risk, "submit");
  assert.equal(action.confirmation, "review");
}

assert.throws(
  () => normalizeActionSpec({ action: "mail.send", title: "Send", risk: "submit", confirmation: "none" }),
  /requires review or explicit/,
);

assert.throws(
  () => normalizeActionSpec({ action: "mail.delete", title: "Delete", risk: "destructive", confirmation: "review" }),
  /destructive.*explicit/,
);

{
  const playbook = normalizePlaybookSpec({
    id: "company-oa",
    name: "Company OA",
    connector: {
      id: "company-oa-web",
      name: "Company OA Web",
      kind: "web",
      capabilities: ["web.open", "web.extract", "web.submit"],
      auth: { type: "browser-session" },
    },
    allowedDomains: ["oa.example.com"],
    baseUrl: "https://oa.example.com",
    actions: [
      {
        action: "web.query-expense-status",
        title: "Query expense status",
        risk: "read",
        confirmation: "none",
        steps: ["Open expense list", "Read status"],
      },
    ],
  });

  assert.equal(playbook.connector.kind, "web");
  assert.equal(playbook.actions[0].action, "web.query-expense-status");
  assert.equal(playbook.allowedDomains[0], "oa.example.com");
}

{
  const redacted = redactConnectorSecrets({
    env: {
      LILY_MAIL_PASSWORD: "secret",
      LILY_API_KEY: "sk-test",
      LILY_MAIL_HOST: "imap.example.com",
    },
    nested: { token: "abc", refreshToken: "def", safe: "value" },
  });
  assert.equal(redacted.env.LILY_MAIL_PASSWORD, "[redacted]");
  assert.equal(redacted.env.LILY_API_KEY, "[redacted]");
  assert.equal(redacted.env.LILY_MAIL_HOST, "imap.example.com");
  assert.equal(redacted.nested.token, "[redacted]");
  assert.equal(redacted.nested.refreshToken, "[redacted]");
  assert.equal(redacted.nested.safe, "value");
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-connector-store-"));
  const store = createConnectorStore({ rootDir: tmp });
  const saved = store.savePlaybook({
    id: "company-oa",
    name: "Company OA",
    baseUrl: "https://oa.example.com",
    allowedDomains: ["oa.example.com"],
    connector: {
      id: "company-oa-web",
      name: "Company OA Web",
      kind: "web",
      capabilities: ["web.open"],
      auth: { type: "browser-session" },
      metadata: { token: "secret-token" },
    },
    actions: [{ action: "web.open", title: "Open", risk: "read", confirmation: "none" }],
  });
  assert.equal(saved.id, "company-oa");
  assert.equal(fs.existsSync(path.join(tmp, "company-oa.json")), true);

  const publicList = store.listPlaybooksPublic();
  assert.equal(publicList.length, 1);
  assert.equal(publicList[0].connector.metadata.token, "[redacted]");
  assert.equal(store.getPlaybook("company-oa").connector.metadata.token, "secret-token");
  assert.equal(store.removePlaybook("company-oa"), true);
  assert.equal(store.listPlaybooksPublic().length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("connector-platform: ok");
