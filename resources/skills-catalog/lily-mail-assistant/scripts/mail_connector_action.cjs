#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const COMMANDS = new Set(["accounts", "test", "search", "read", "send"]);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS.has(command)) return usage();
  const args = parseArgs(rest);
  const bridgeUrl = process.env.LILY_CONNECTOR_BRIDGE_URL;
  const bridgeToken = process.env.LILY_CONNECTOR_BRIDGE_TOKEN;
  if (!bridgeUrl || !bridgeToken) {
    throw new Error("Mail connector bridge is not available. Open Lily Workbench and run this skill inside a connected chat.");
  }

  if (command === "accounts") {
    return printJson(await postJson(bridgeUrl, bridgeToken, "/v1/mail/accounts", {}));
  }

  const accountId = args.account || args.accountId || args.id;
  if (!accountId) throw new Error("--account is required");

  if (command === "test") {
    return printJson(await postJson(bridgeUrl, bridgeToken, "/v1/mail/test", { accountId }));
  }
  if (command === "search") {
    return printJson(await postJson(bridgeUrl, bridgeToken, "/v1/mail/search", {
      accountId,
      query: readJsonArg(args.query, {}),
    }));
  }
  if (command === "read") {
    const query = readJsonArg(args.query, {});
    if (args.uid) query.uid = Number(args.uid);
    if (args.messageId) query.messageId = args.messageId;
    if (args.id) query.id = args.id;
    if (args.mailbox) query.mailbox = args.mailbox;
    return printJson(await postJson(bridgeUrl, bridgeToken, "/v1/mail/read", { accountId, query }));
  }
  if (command === "send") {
    const message = args.message ? readJsonFile(args.message) : readJsonArg(args.body, {});
    return printJson(await postJson(bridgeUrl, bridgeToken, "/v1/mail/send", {
      accountId,
      message,
      confirmed: args.confirmed === true || args.confirmed === "true",
    }));
  }
}

function parseArgs(values) {
  const args = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function readJsonArg(value, fallback) {
  if (!value) return fallback;
  return JSON.parse(value);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function postJson(baseUrl, token, route, payload) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `mail connector request failed: ${response.status}`);
  }
  return data;
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function usage() {
  process.stderr.write(`usage:
  node scripts/mail_connector_action.cjs accounts
  node scripts/mail_connector_action.cjs test --account <account-id>
  node scripts/mail_connector_action.cjs search --account <account-id> --query '{"limit":5}'
  node scripts/mail_connector_action.cjs read --account <account-id> --uid <imap-uid>
  node scripts/mail_connector_action.cjs read --account <account-id> --id <provider-message-id>
  node scripts/mail_connector_action.cjs send --account <account-id> --message reply.json --confirmed
`);
  process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exitCode = 1;
});
