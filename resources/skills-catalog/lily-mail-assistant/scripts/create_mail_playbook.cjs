#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const PROVIDERS = new Set(["gmail", "outlook", "microsoft-365", "imap-smtp"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/create_mail_playbook.cjs --spec mail-connector.json --out mail-playbook.json",
    "",
    "The spec must contain id, name, provider, account, and secretRefs[].",
    "Never put raw passwords/API keys/tokens in the spec.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { spec: "", out: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec") args.spec = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.spec) throw new Error("Missing --spec");
  if (!args.out) throw new Error("Missing --out");
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanId(value, field = "id") {
  const id = cleanText(value).toLowerCase();
  if (!ID_RE.test(id)) throw new Error(`${field} is invalid`);
  return id;
}

function rejectInlineSecrets(spec) {
  for (const key of ["password", "token", "apiKey", "api_key", "refreshToken", "accessToken"]) {
    if (spec[key]) throw new Error(`Do not store ${key}; use secretRefs instead`);
  }
}

function normalizeHostPort(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const host = cleanText(value.host);
  if (!host) throw new Error(`${field}.host is required`);
  const port = Number(value.port || (field === "imap" ? 993 : 465));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${field}.port is invalid`);
  return { host, port, secure: value.secure !== false };
}

function validateSpec(input) {
  const spec = { ...input };
  rejectInlineSecrets(spec);
  spec.id = cleanId(spec.id);
  spec.name = cleanText(spec.name || spec.id);
  if (!spec.name) throw new Error("name is required");
  spec.provider = cleanText(spec.provider || "imap-smtp").toLowerCase();
  if (!PROVIDERS.has(spec.provider)) throw new Error(`provider is invalid: ${spec.provider}`);
  spec.account = cleanText(spec.account);
  if (!spec.account || !spec.account.includes("@")) throw new Error("account must be an email address");
  spec.secretRefs = Array.isArray(spec.secretRefs) ? spec.secretRefs.map(cleanText).filter(Boolean) : [];
  if (spec.secretRefs.length === 0) throw new Error("secretRefs must contain at least one keychain/app secret reference");
  spec.imap = normalizeHostPort(spec.imap, "imap");
  spec.smtp = normalizeHostPort(spec.smtp, "smtp");
  if (spec.provider === "imap-smtp" && (!spec.imap || !spec.smtp)) {
    throw new Error("imap-smtp provider requires imap and smtp settings");
  }
  return spec;
}

function buildAuth(spec) {
  if (spec.provider === "gmail" || spec.provider === "outlook" || spec.provider === "microsoft-365") {
    return {
      type: "oauth2",
      secretRefs: spec.secretRefs,
      scopes: spec.provider === "gmail"
        ? ["gmail.readonly", "gmail.compose", "gmail.send"]
        : ["Mail.Read", "Mail.ReadWrite", "Mail.Send"],
      notes: "OAuth tokens are stored by the application/keychain. They are never written into this playbook.",
    };
  }
  return {
    type: "password",
    secretRefs: spec.secretRefs,
    scopes: ["imap.read", "smtp.send"],
    notes: "Use an app password/token stored outside the playbook.",
  };
}

function buildPlaybook(spec) {
  return {
    schemaVersion: 1,
    id: spec.id,
    name: spec.name,
    description: `${spec.name} mail connector for ${spec.account}.`,
    baseUrl: `https://${spec.provider}.mail.local`,
    allowedDomains: [`${spec.provider}.mail.local`],
    connector: {
      schemaVersion: 1,
      id: `${spec.id}-mail`,
      name: `${spec.name} Mail`,
      kind: "mail",
      description: `Mail connector for ${spec.account}.`,
      capabilities: [
        "mail.search",
        "mail.read",
        "mail.summarize",
        "mail.find_attachments",
        "mail.draft_reply",
        "mail.send",
        "mail.archive",
        "mail.delete",
      ],
      auth: buildAuth(spec),
      allowRemoteConfig: true,
      metadata: {
        provider: spec.provider,
        account: spec.account,
        imap: spec.imap,
        smtp: spec.smtp,
      },
    },
    actions: [
      { action: "mail.search", title: "Search mail", risk: "read", confirmation: "none" },
      { action: "mail.read", title: "Read mail", risk: "read", confirmation: "none" },
      { action: "mail.summarize", title: "Summarize mail", risk: "read", confirmation: "none" },
      { action: "mail.find_attachments", title: "Find attachments", risk: "read", confirmation: "none" },
      { action: "mail.draft_reply", title: "Draft reply", risk: "prepare", confirmation: "review" },
      { action: "mail.send", title: "Send mail", risk: "submit", confirmation: "explicit" },
      { action: "mail.archive", title: "Archive mail", risk: "destructive", confirmation: "explicit" },
      { action: "mail.delete", title: "Delete mail", risk: "destructive", confirmation: "explicit" },
    ].map((action) => ({
      ...action,
      connectorKind: "mail",
      intentExamples: [],
      steps: [],
      selectors: [],
      paramsSchema: {},
      resultSchema: {},
    })),
    createdAt: new Date().toISOString(),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const spec = validateSpec(readJson(args.spec));
  const playbook = buildPlaybook(spec);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), JSON.stringify(playbook, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, id: spec.id, out: path.resolve(args.out), provider: spec.provider }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
}
