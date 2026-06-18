#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "dist", "workspace-apps");
const APP_ID = "web-system-learning";
const APP_NAME = "网页系统学习";
const REQUIRED_SKILLS = ["lily-web-system-learning"];

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
    "Usage: node scripts/build-web-system-learning-workspace-app.mjs [--out dist/workspace-apps] [--version 1.0.0] [--exported-at ISO]",
    "",
    "Builds the Lily-native web system learning workspace app package.",
  ].join(os.EOL);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readme() {
  return `# Lily App: 网页系统学习

网页系统学习把 OA、ERP、CRM、后台、门户和其他 Web 系统变成当前工作区可审核的自然语言能力。

它不是让 AI 随便点网页，而是先在用户授权范围内学习系统结构，生成页面地图、动作地图和
连接器 Playbook，再生成当前工作区专属技能草稿。用户审核启用后，后续才能用自然语言操作。

## 使用方式

\`\`\`text
学习我们的 OA 系统，以后帮我查报销进度
学习这个 CRM，后续帮我找客户跟进记录
学习后台订单系统，只允许查询和导出，不允许修改订单
\`\`\`

## 标准流程

1. 用户提供系统入口 URL、业务目标和允许访问的域名。
2. 用户在浏览器里自己完成登录；不要把账号、密码、Cookie、Token 或验证码粘贴到聊天里。
3. Lily 默认只读扫描页面：菜单、列表、详情、表单字段、按钮、导出入口。
4. Lily 生成能力地图、API 地图、页面/动作地图和 \`web-system-playbook.json\`。
5. Lily 生成健康报告和当前工作区专属技能草稿。
6. 用户审核并启用技能。
7. 后续自然语言执行时，先匹配能力、补齐必填参数、dry-run 校验，再按 API 优先 / 浏览器兜底执行；提交、审批、删除、上传、付款、通知等动作必须二次确认。

## 安全边界

- 学习阶段默认只读，不提交表单、不审批、不删除、不付款、不上传、不发通知。
- 每个系统必须有域名白名单，不能跳出用户授权范围。
- 凭据和登录态由浏览器或应用安全存储，不能写进工作区文件。
- 页面变化后，应重新做只读发现，而不是继续猜测旧选择器。
- 生成的工作区技能默认待审核，用户启用后才生效。

## 产物说明

| 文件 | 作用 |
|---|---|
| \`system-profile.json\` | 系统画像、范围、登录策略和档案索引 |
| \`capability-map.json\` | 能力路由、必填参数、确认策略、成功信号、过期信号和恢复策略 |
| \`api-map.json\` | 学到的 API 合约、请求字段和可复用能力映射 |
| \`health.json\` | 学习覆盖率、API 优先能力数量、风险动作和建议补学项 |
| \`page-map.json\` | 页面地图、入口、锚点和页面关系 |
| \`domain-model.json\` | 业务对象、字段语义、词汇表和待补问题 |
| \`risk-policy.json\` | 域名白名单、学习期禁区和动作确认策略 |
| \`examples.jsonl\` | 用户自然语言说法到动作的样例映射 |
| \`change-log.json\` | 学习、重学和页面变化记录 |
| \`web-system-learning-playbook.template.json\` | 连接器 Playbook 模板 |
| \`web-system-learning-checklist.md\` | 学习前检查清单 |
| \`AGENTS.md\` | 当前工作区的执行边界 |

## 已依赖能力

安装本应用时会要求启用 \`${REQUIRED_SKILLS.join("`、`")}\` 技能。
`;
}

function agentsMd() {
  return `# Lily Web System Learning App

You are working inside the Lily Workbench web system learning app.

## Required Skill

Use \`${REQUIRED_SKILLS.join("`, `")}\` for all OA / ERP / CRM / admin system learning work.

## Product Contract

- Learn only inside user-approved domains.
- Keep learning read-only by default.
- Never ask users to paste passwords, cookies, tokens, OAuth codes, or one-time codes into chat.
- Ask the user to log in through an interactive browser/profile when needed.
- Produce a page map, action map, connector playbook, and workspace skill draft.
- Produce a capability map, API map, health report, page map, action map, connector playbook, and workspace skill draft.
- Generated skills are drafts until the user reviews and enables them.

## Risk Rules

- Read actions may search, open detail pages, summarize, and export only when the user has allowed that scope.
- Prepare actions may fill drafts but must stop before submit.
- Submit actions must show final fields and wait for explicit confirmation.
- Destructive actions such as delete, approve, reject, pay, revoke, permission changes, upload, and notification must require explicit confirmation naming the exact target.

## Execution Rules

- Do not browse outside the allowlist.
- Do not store credentials or page secrets in generated files.
- If selectors become unstable, re-run read-only discovery for that action.
- If the system exposes unrelated sensitive data, stop and narrow the scope.
- If a CAPTCHA, 2FA, SSO re-auth, or permission prompt appears, hand control back to the user.
- During execution, always route through the generated capability map first. Missing required parameters must be collected before browser/API execution.
`;
}

function checklist() {
  return `# 网页系统学习检查清单

## 学习前

- [ ] 系统入口 URL 已确认。
- [ ] 允许访问的域名白名单已确认。
- [ ] 用户已说明业务目标，例如查询报销、查询订单、生成客户摘要。
- [ ] 禁止区域已确认，例如审批、付款、删除、权限管理。
- [ ] 用户通过浏览器自己登录，不在聊天中提供账号密码。

## 学习中

- [ ] 只读扫描菜单、列表、详情、表单字段和按钮。
- [ ] 记录可复用 API 合约、请求字段、响应形状和对应能力。
- [ ] 不提交表单。
- [ ] 不删除、不审批、不付款、不上传、不发通知。
- [ ] 记录稳定选择器、页面标题、URL 模式和可读标签。
- [ ] 对低代码或 Canvas 页面记录视觉 fallback。

## 学习后

- [ ] 生成页面地图。
- [ ] 生成动作地图。
- [ ] 生成 \`capability-map.json\`，包含能力、必填参数、确认策略和过期信号。
- [ ] 生成 \`api-map.json\`，把可复用接口映射到能力。
- [ ] 生成 \`health.json\`，标明覆盖率、缺口和建议补学项。
- [ ] 生成 \`web-system-playbook.json\`。
- [ ] 生成当前工作区专属技能草稿。
- [ ] 用户审核后再启用技能。
`;
}

function playbookTemplate() {
  return JSON.stringify(
    {
      schemaVersion: 1,
      connector: "web-system",
      appId: APP_ID,
      system: {
        name: "待学习系统",
        baseUrl: "https://example.com",
        allowedDomains: ["example.com"],
      },
      actions: [
        {
          action: "web.query-status",
          name: "查询状态",
          risk: "read",
          confirmation: "none",
          intentExamples: ["查一下我的申请进度", "这个订单现在是什么状态"],
          steps: [
            { op: "goto", url: "https://example.com" },
            { op: "extract", selector: "main", description: "Extract relevant status rows." },
          ],
        },
        {
          action: "web.prepare-form",
          name: "准备表单",
          risk: "prepare",
          confirmation: "review",
          intentExamples: ["帮我填一份申请草稿"],
          steps: [
            { op: "goto", url: "https://example.com/form" },
            { op: "fill", selector: "[name='title']", valueFrom: "title" },
          ],
        },
      ],
      apiContracts: [],
      credentialPolicy: {
        chatSecrets: false,
        login: "interactive-browser-session",
        notes: "Do not store passwords, cookies, tokens, OAuth codes, or screenshots containing secrets in workspace files.",
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
    ["web-system-learning-checklist.md", checklist()],
    ["web-system-learning-playbook.template.json", playbookTemplate()],
  ]);

  const manifest = {
    schemaVersion: 1,
    kind: "lily-workspace-app",
    appId: APP_ID,
    name: APP_NAME,
    folderName: APP_ID,
    description:
      "学习 OA、ERP、CRM、后台等 Web 系统，生成页面地图、动作地图、连接器 Playbook 和当前工作区可审核技能。",
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
      "# 网页系统学习约定",
      "",
      "- 用户必须通过浏览器自己登录，不在聊天或工作区文件中保存凭据。",
      "- 学习阶段默认只读，不提交、不删除、不审批、不付款、不上传、不通知。",
      "- 每个动作必须有风险等级和确认策略。",
      "- 生成技能草稿后，用户审核启用才生效。",
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
