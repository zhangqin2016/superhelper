#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { normalizePlaybookSpec } = require("../src/main/connector-protocol.js");

const skillDir = path.join(ROOT, "resources/skills-catalog/lily-mail-assistant");
const script = path.join(skillDir, "scripts/create_mail_playbook.cjs");

if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) throw new Error("lily-mail-assistant SKILL.md missing");
if (!fs.existsSync(path.join(skillDir, "skill.manifest.json"))) throw new Error("lily-mail-assistant manifest missing");
if (!fs.existsSync(script)) throw new Error("lily-mail-assistant playbook script missing");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mail-assistant-"));
const specPath = path.join(tmp, "mail.json");
const outPath = path.join(tmp, "mail-playbook.json");

fs.writeFileSync(
  specPath,
  JSON.stringify({
    id: "team-mail",
    name: "Team Mail",
    provider: "imap-smtp",
    account: "ops@example.com",
    imap: { host: "imap.example.com", port: 993, secure: true },
    smtp: { host: "smtp.example.com", port: 465, secure: true },
    secretRefs: ["mail-ops-password"],
  }),
);

const result = spawnSync(process.execPath, [script, "--spec", specPath, "--out", outPath], {
  cwd: ROOT,
  encoding: "utf8",
});
if (result.status !== 0) throw new Error(`create_mail_playbook failed: ${result.stderr || result.stdout}`);

const playbook = JSON.parse(fs.readFileSync(outPath, "utf8"));
const normalized = normalizePlaybookSpec(playbook);
assertMailPlaybook(normalized);

const serialized = JSON.stringify(playbook);
if (/password123|sk-|secret-value/i.test(serialized)) {
  throw new Error("mail playbook must not contain raw secrets");
}

const badSpecPath = path.join(tmp, "bad.json");
fs.writeFileSync(
  badSpecPath,
  JSON.stringify({
    id: "bad-mail",
    name: "Bad Mail",
    provider: "imap-smtp",
    account: "ops@example.com",
    imap: { host: "imap.example.com", port: 993, secure: true },
    smtp: { host: "smtp.example.com", port: 465, secure: true },
    password: "password123",
  }),
);
const bad = spawnSync(process.execPath, [script, "--spec", badSpecPath, "--out", path.join(tmp, "bad-playbook.json")], {
  cwd: ROOT,
  encoding: "utf8",
});
if (bad.status === 0 || !bad.stderr.includes("secretRefs")) {
  throw new Error("mail playbook generator must reject inline passwords");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("mail-assistant-skill: ok");

function assertMailPlaybook(playbook) {
  if (playbook.connector.kind !== "mail") throw new Error(`expected mail connector: ${JSON.stringify(playbook.connector)}`);
  if (!playbook.connector.capabilities.includes("mail.search")) throw new Error("mail.search capability missing");
  if (!playbook.actions.some((action) => action.action === "mail.draft_reply" && action.risk === "prepare")) {
    throw new Error("mail draft reply action missing");
  }
  const send = playbook.actions.find((action) => action.action === "mail.send");
  if (!send || send.risk !== "submit" || send.confirmation !== "explicit") {
    throw new Error(`mail.send must require explicit confirmation: ${JSON.stringify(send)}`);
  }
}
