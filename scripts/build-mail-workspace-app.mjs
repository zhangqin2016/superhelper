#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "dist", "workspace-apps");
const APP_ID = "mail-assistant";
const APP_NAME = "邮件助手";
const REQUIRED_SKILLS = ["lily-mail-assistant"];

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    version: "1.0.0",
    exportedAt: new Date().toISOString(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--out-dir") args.outDir = path.resolve(argv[++i] || "");
    else if (arg === "--version") args.version = argv[++i] || "";
    else if (arg === "--exported-at") args.exportedAt = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/build-mail-workspace-app.mjs [--out dist/workspace-apps] [--version 1.0.0] [--exported-at ISO]",
    "",
    "Builds the Lily-native mail assistant workspace app package.",
  ].join(os.EOL);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readme() {
  return `# Lily App: 邮件助手

邮件助手是 Lily Workbench 的邮箱连接器应用。它把 Gmail、Outlook / Microsoft 365
和 IMAP/SMTP 邮箱接入当前工作区，让用户可以用自然语言搜索邮件、总结线程、
查找附件、起草回复，并在明确确认后发送。

## 适合怎么用

\`\`\`text
总结今天客户发来的未读邮件，按紧急程度排序
找出上周包含合同附件的邮件
帮我给王总草拟一封回复，说明本周五前给方案
把这封草稿发出去
\`\`\`

## 连接账号

- Gmail：通过 OAuth 授权连接 Gmail API。
- Outlook / Microsoft 365：通过 OAuth 授权连接 Microsoft Graph。
- IMAP / SMTP：使用邮箱服务商生成的 app password 或 token，凭据由应用安全存储。

不要把邮箱密码、Cookie、OAuth code 或 API token 粘贴到聊天里。账号连接入口在：

\`\`\`text
设置 -> Connectors -> Mail
\`\`\`

## 安全边界

- 搜索、读取、总结默认是只读动作。
- 草拟回复只生成草稿，不会自动发送。
- 发送、删除、归档、批量移动邮件必须先展示影响范围，并等待用户明确确认。
- 工作区文件里只保存操作说明和 playbook，不保存邮件正文、附件内容或任何凭据。

## 可审计动作

所有邮件动作都走标准连接器协议：

| Action | 风险 | 确认要求 |
|---|---|---|
| \`mail.search\` | 只读 | 无需确认 |
| \`mail.read\` | 只读 | 无需确认 |
| \`mail.summarize\` | 只读 | 无需确认 |
| \`mail.find_attachments\` | 只读 | 无需确认 |
| \`mail.draft_reply\` | 准备 | 用户审阅 |
| \`mail.send\` | 提交 | 必须确认 |
| \`mail.archive\` | 状态变更 | 必须确认 |
| \`mail.delete\` | 删除 | 必须确认 |
`;
}

function agentsMd() {
  return `# Lily Mail Assistant App

You are working inside the Lily Workbench mail assistant app.

## Required Skill

Use \`${REQUIRED_SKILLS.join("`, `")}\` for all email work.

## Connector Contract

- Email work must use the standard \`mail.*\` connector action protocol.
- Keep credentials out of chat, files, logs, and generated artifacts.
- Ask users to connect accounts in Settings -> Connectors when no account is available.
- Search, read, summarize, and attachment lookup are read-only.
- Draft replies first. Do not send until the user reviews the exact message and explicitly approves sending.
- Delete, archive, move, label, and bulk mailbox changes require explicit confirmation with the affected message list.

## Provider Notes

- Gmail uses OAuth and the Gmail API.
- Outlook / Microsoft 365 uses OAuth and Microsoft Graph.
- IMAP / SMTP uses an app password or token stored by the application/keychain through a secret reference.

## Output Rules

- Cite sender, date, and subject when summarizing.
- Do not paste full sensitive message bodies unless the user asks and the content is needed.
- For attachments, show filename, sender, date, and intended save/open action before exporting.
- If a connector is unavailable, say what account setup is missing instead of inventing results.
`;
}

function playbook() {
  return JSON.stringify(
    {
      schemaVersion: 1,
      connector: "mail",
      appId: APP_ID,
      actions: [
        { id: "mail.search", risk: "read", confirmation: "none" },
        { id: "mail.read", risk: "read", confirmation: "none" },
        { id: "mail.summarize", risk: "read", confirmation: "none" },
        { id: "mail.find_attachments", risk: "read", confirmation: "none" },
        { id: "mail.draft_reply", risk: "prepare", confirmation: "review" },
        { id: "mail.send", risk: "submit", confirmation: "explicit" },
        { id: "mail.archive", risk: "destructive", confirmation: "explicit" },
        { id: "mail.delete", risk: "destructive", confirmation: "explicit" },
      ],
      providers: ["gmail", "microsoft-graph", "imap-smtp"],
      credentialPolicy: {
        chatSecrets: false,
        store: "app-keychain-or-server-secret-ref",
        notes: "Workspace files must never contain passwords, tokens, cookies, OAuth codes, or message bodies.",
      },
    },
    null,
    2,
  );
}

async function build(args) {
  if (!args.version) throw new Error("--version is required");
  if (!args.outDir) throw new Error("--out is required");
  const exportedAt = new Date(args.exportedAt);
  if (Number.isNaN(exportedAt.getTime())) throw new Error("--exported-at must be a valid ISO date");

  const files = new Map([
    ["README.md", readme()],
    ["AGENTS.md", agentsMd()],
    ["mail-playbook.example.json", playbook()],
  ]);

  const manifest = {
    schemaVersion: 1,
    kind: "lily-workspace-app",
    appId: APP_ID,
    name: APP_NAME,
    folderName: APP_ID,
    description:
      "连接 Gmail、Outlook/Microsoft 365 或 IMAP/SMTP，用自然语言搜索、总结、查找附件、草拟回复，并在确认后发送邮件。",
    exportedAt: exportedAt.toISOString(),
    fileCount: files.size,
    hasConventions: true,
    requiredSkills: REQUIRED_SKILLS,
    requiredRuntimePacks: [],
  };

  const zip = new JSZip();
  zip.file("lily-workspace.json", `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file(
    "conventions.md",
    [
      "# 邮件助手约定",
      "",
      "- 邮件账号必须通过设置页连接，不在聊天或工作区文件中保存凭据。",
      "- 发送、删除、归档、批量移动等动作必须显式确认。",
      "- 总结结果要标注发件人、日期和主题，方便用户核对来源。",
      "",
    ].join("\n"),
  );
  for (const [relPath, content] of files) {
    zip.file(`files/${relPath}`, content.endsWith("\n") ? content : `${content}\n`);
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.mkdirSync(args.outDir, { recursive: true });
  const fileName = `${APP_ID}-${args.version}.lilyspace.zip`;
  const outPath = path.join(args.outDir, fileName);
  fs.writeFileSync(outPath, buffer);

  return {
    appId: APP_ID,
    name: APP_NAME,
    version: args.version,
    path: outPath,
    fileName,
    sizeBytes: buffer.length,
    sha256: sha256(buffer),
    requiredSkills: REQUIRED_SKILLS,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await build(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
