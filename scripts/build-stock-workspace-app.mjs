#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE_DIR = path.join(ROOT, ".lily-work", "app-build", "daily-stock-analysis");
const DEFAULT_OUT_DIR = path.join(ROOT, "dist", "workspace-apps");
const APP_ID = "daily-stock-analysis";
const APP_NAME = "股票智能分析 Starter";
const REQUIRED_SKILLS = [
  "lily-stock-research",
  "lily-research-synthesis",
  "lily-excel-data-analysis",
  "lily-code-repair",
];

const EXCLUDED_DIRS = new Set([
  ".git",
  ".github",
  ".claude",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "reports",
  ".lily-stock-cache",
  ".lily-stock-memory",
]);

const EXCLUDED_REL_PREFIXES = [
  "source/.claude/",
  "source/.github/",
  "source/tests/",
  "source/assets/cli/",
];

const EXCLUDED_FILE_RE =
  /(^|\/)(\.env|\.npmrc|\.netrc|id_rsa|\.git-credentials)$|\.(key|pem|p12|pfx|crt|cer|keystore|jks)$/i;
const ENV_TEMPLATE_RE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

function parseArgs(argv) {
  const args = {
    sourceDir: DEFAULT_SOURCE_DIR,
    outDir: DEFAULT_OUT_DIR,
    version: "1.0.2",
    exportedAt: "2026-06-15T00:00:00.000Z",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source" || arg === "--source-dir") args.sourceDir = path.resolve(argv[++i] || "");
    else if (arg === "--out" || arg === "--out-dir") args.outDir = path.resolve(argv[++i] || "");
    else if (arg === "--version") args.version = argv[++i] || "";
    else if (arg === "--exported-at") args.exportedAt = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/build-stock-workspace-app.mjs [--source .lily-work/app-build/daily-stock-analysis] [--version 1.0.2] [--exported-at ISO]",
    "",
    "Builds the Lily-native daily-stock-analysis workspace app package.",
  ].join(os.EOL);
}

function isExcluded(relPath, isDir) {
  const normalized = relPath.split(path.sep).join("/");
  if (EXCLUDED_REL_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return true;
  }
  const segments = normalized.split("/");
  if (isDir && segments.some((seg) => EXCLUDED_DIRS.has(seg))) return true;
  if (ENV_TEMPLATE_RE.test(normalized)) return false;
  return EXCLUDED_FILE_RE.test(normalized);
}

function walkFiles(rootDir, dir = rootDir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(rootDir, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!isExcluded(rel, true)) walkFiles(rootDir, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isExcluded(rel, false)) continue;
    if (rel === "lily-workspace.json" || rel === "conventions.md") continue;
    files.push({ fullPath, rel, size: fs.statSync(fullPath).size });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function rootReadme() {
  return `# Lily App: 股票智能分析 Starter

这是 Lily Workbench 的股票研究示范应用，基于 MIT 开源项目
\`TauricResearch/TradingAgents\` 改造成可开箱即用的多 Agent 投研工作区。

## 平台原生能力

- 安装应用时会通过 Lily 服务端自动安装所需技能：
  \`${REQUIRED_SKILLS.join("`、`")}\`。
- 优先使用 Lily 已配置的模型、搜索和联网研究能力，不要求用户重复填写模型 Key。
- 底层采用 TradingAgents 的 Analyst / Researcher / Trader / Risk / Portfolio Manager 多 Agent 流程。
- Lily 已内置联网搜索（阿里 IQS / SearXNG / DuckDuckGo 等可切换后端）。
  不要把 Bocha、Tavily、SerpAPI、Brave、MiniMax、Anspire 等第三方搜索 Key
  当成普通用户的“待改进项”。
- 优先使用 Lily bundled Python / uv；缺少股票项目依赖时，在当前工作区创建隔离环境。
- 研究输出必须区分事实、模型推断和风险提示，不构成投资建议。
- 交易历史短、yfinance 财务字段缺失、新闻不足等只能写成“本次数据限制”和置信度影响，
  不要输出泛泛的“要让 App 输出更高质量还需要...”清单。

## 快速使用

在 Lily 对话里直接说：

\`\`\`text
用股票应用分析 600519、AAPL，并说明数据来源、风险和结论置信度
\`\`\`

助手会先检查配置和依赖，做小样本 dry-run，再扩大到完整自选股。

如果需要手动运行：

\`\`\`bash
cd source
uv venv .venv-lily-stock
. .venv-lily-stock/bin/activate
uv pip install -e .
python lily_run.py --stocks 600519,AAPL --dry-run
python lily_run.py --stocks 600519,AAPL
\`\`\`

Windows PowerShell：

\`\`\`powershell
cd source
uv venv .venv-lily-stock
.\\.venv-lily-stock\\Scripts\\Activate.ps1
uv pip install -e .
python lily_run.py --stocks 600519,AAPL --dry-run
python lily_run.py --stocks 600519,AAPL
\`\`\`

## 上游项目

- GitHub: https://github.com/TauricResearch/TradingAgents
- License: MIT
- 本应用保留上游 \`LICENSE\` 和 \`source/README_UPSTREAM.md\`。

## 风险提示

本应用只用于信息整理和研究辅助，不构成投资建议。股票市场有风险，任何买卖决策都需要用户自行判断。
`;
}

function agentsMd() {
  return `# Lily Stock Analysis App

You are working inside the Lily Workbench stock analysis app.

## Platform Rules

- Use Lily platform resources first: configured model env, search env, bundled Python, bundled uv, and installed Lily skills.
- Required Lily skills for this workspace: ${REQUIRED_SKILLS.join(", ")}.
- Treat all outputs as research assistance, never financial advice.
- Separate facts, inference, and risk notes.
- Do not invent prices, financials, analyst ratings, news, filings, or market events.
- Prefer current source-backed research for prices, news, policies, earnings, and market-moving events.
- Do not recommend Bocha, Tavily, SerpAPI, Brave, MiniMax, Anspire, or other third-party search keys as routine improvements. Lily platform search is the default search path when available.
- Do not end reports with generic "improvement items" or "to make the app better" checklists. Put missing trading history, missing fundamentals, stale data, or no reliable news into a "本次数据限制" section with direct confidence impact.
- Do not globally install Python packages. Use a workspace-local environment when dependencies are missing.

## Startup Checklist

1. Read \`README.md\`, \`source/.env.example\`, and \`source/README.md\`.
2. Use Lily platform model/search env. Do not ask ordinary users to configure upstream OpenAI/Anthropic/search keys.
3. Check whether \`python\` and \`uv\` resolve from Lily's bundled runtime.
4. If app dependencies are missing, create \`source/.venv-lily-stock\` and install the package with \`uv pip install -e .\`.
5. Run a tiny dry run before any full analysis.

## Useful Commands

\`\`\`bash
cd source
python lily_run.py --stocks 600519,AAPL --dry-run
python lily_run.py --stocks 600519,AAPL
\`\`\`

If dependencies are missing:

\`\`\`bash
cd source
uv venv .venv-lily-stock
. .venv-lily-stock/bin/activate
uv pip install -e .
python lily_run.py --stocks 600519,AAPL --dry-run
\`\`\`

## Output Requirements

- Include data timestamp, source names/links where available, missing data, and uncertainty.
- For tables or watchlists, create reviewable CSV/XLSX outputs when useful.
- If data is thin, use "本次数据限制" wording. Do not frame platform search keys or third-party provider keys as customer setup requirements.
- Always include: "This is research assistance, not investment advice."
`;
}

function lilyMainWrapper() {
  return `#!/usr/bin/env python3
"""Compatibility wrapper for Lily Workbench stock analysis.

The upstream TradingAgents sample used provider defaults directly. In Lily, all
manual and agent-driven runs must go through lily_run.py so platform-managed
model/search configuration is applied before TradingAgents is imported.
"""

from __future__ import annotations

from lily_run import main


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function conventions() {
  return `# 股票智能分析应用约定

- 优先使用 Lily 平台搜索、模型配置、bundled Python/uv 和已安装技能。
- 输出必须包含“不是投资建议”的风险提示。
- 不要把模型判断伪装成事实；事实、推断、建议观察要分开。
- 数据源失败、缺 Key、行情过期或 API 限流时要显式说明。
- 平台搜索可用时，不能把 Bocha/Tavily/SerpAPI 等第三方搜索 Key 写成待改进项。
- 交易历史不足、yfinance 字段缺失、新闻不足等写入“本次数据限制”，不要写泛泛的“要让 App 输出更高质量还需要...”。
- 默认先做小范围样例运行，再扩大到完整自选股。
`;
}

function platformGuide() {
  return `# Lily Platform Integration

This workspace app is designed to run inside Lily Workbench.

## Installed Skills

The app declares these Lily skill dependencies:

${REQUIRED_SKILLS.map((id) => `- ${id}`).join("\n")}

The client installs them through the server-managed skill registry before the
workspace is created.

## Search

Use Lily Workbench platform search first. The user should not be told to
configure Bocha, Tavily, SerpAPI, Brave, MiniMax, Anspire, or another third-party
search key just to improve normal reports. If the upstream app lacks direct news
API keys, supplement with Lily research/search and cite those sources.

When market data is thin, write a data-limit note instead of an improvement
checklist:

- newly listed ticker: trading history is short, technical indicators have low confidence;
- missing fundamentals: provider did not expose PE/ROE/financial fields for this ticker;
- sparse news: Lily search found no sufficiently reliable source in the requested window.

## Runtime

Use the Lily-bundled Python and uv when available. Heavy stock-analysis Python
dependencies should be installed into \`.venv-lily-stock\` inside this workspace,
not globally and not into Lily's read-only app bundle.

The app entrypoint is \`source/lily_run.py\`. It maps Lily's \`LILY_API_KEY\`,
\`LILY_API_BASE_URL\`, \`LILY_MODEL\`, and related platform env to TradingAgents'
non-interactive \`TRADINGAGENTS_*\` configuration, so ordinary users do not need
to configure upstream provider keys.

\`source/main.py\` is packaged as a Lily compatibility wrapper that delegates to
\`source/lily_run.py\`; do not replace it with the upstream demo script.

Future versions may move these dependencies into a dedicated \`stock-analysis\`
runtime pack once artifacts exist for macOS, Windows, and Linux.
`;
}

function assertRequiredSource(sourceDir) {
  const required = ["source/lily_run.py", "source/lily_adapter.py", "source/pyproject.toml"];
  for (const rel of required) {
    const fullPath = path.join(sourceDir, ...rel.split("/"));
    if (!fs.existsSync(fullPath)) {
      throw new Error(`stock app source missing required Lily integration file: ${rel}`);
    }
  }
}

async function build({ sourceDir, outDir, version, exportedAt }) {
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) {
    throw new Error(`invalid version: ${version}`);
  }
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`source dir not found: ${sourceDir}`);
  }
  assertRequiredSource(sourceDir);

  const files = walkFiles(sourceDir);
  const zip = new JSZip();
  const fixedDate = new Date("2000-01-01T00:00:00.000Z");
  const workspaceFileNames = new Set(files.map((file) => file.rel));

  for (const file of files) {
    zip.file(`files/${file.rel}`, fs.readFileSync(file.fullPath), {
      createFolders: false,
      date: fixedDate,
      unixPermissions: 0o644,
    });
  }

  workspaceFileNames.add("README.md");
  workspaceFileNames.add("AGENTS.md");
  workspaceFileNames.add("source/LILY_PLATFORM.md");
  zip.file("files/README.md", rootReadme(), { createFolders: false, date: fixedDate, unixPermissions: 0o644 });
  zip.file("files/AGENTS.md", agentsMd(), { createFolders: false, date: fixedDate, unixPermissions: 0o644 });
  zip.file("files/source/LILY_PLATFORM.md", platformGuide(), { createFolders: false, date: fixedDate, unixPermissions: 0o644 });
  zip.file("files/source/main.py", lilyMainWrapper(), { createFolders: false, date: fixedDate, unixPermissions: 0o755 });
  zip.file("conventions.md", conventions(), { createFolders: false, date: fixedDate, unixPermissions: 0o644 });

  const manifest = {
    schemaVersion: 1,
    kind: "lily-workspace-app",
    appId: APP_ID,
    name: APP_NAME,
    folderName: APP_ID,
    description: "基于 MIT 高星项目 TauricResearch/TradingAgents 的 Lily 原生多 Agent 股票研究工作区，自动依赖平台股票研究、联网核验、表格分析和代码修复技能。",
    version,
    exportedAt: String(exportedAt || "2026-06-15T00:00:00.000Z"),
    fileCount: workspaceFileNames.size,
    hasConventions: true,
    requiredSkills: REQUIRED_SKILLS,
    requiredRuntimePacks: [],
    entry: {
      type: "workspace",
      path: "README.md",
    },
    source: {
      kind: "github",
      repo: "TauricResearch/TradingAgents",
      license: "MIT",
    },
    permissions: {
      network: true,
      filesystem: "workspace",
    },
  };
  zip.file("lily-workspace.json", `${JSON.stringify(manifest, null, 2)}\n`, {
    createFolders: false,
    date: fixedDate,
    unixPermissions: 0o644,
  });

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });

  fs.mkdirSync(outDir, { recursive: true });
  const artifactPath = path.join(outDir, `${APP_ID}-${version}.lilyspace.zip`);
  fs.writeFileSync(artifactPath, buffer);
  return {
    appId: APP_ID,
    version,
    artifactPath,
    sha256: sha256(buffer),
    sizeBytes: buffer.length,
    requiredSkills: REQUIRED_SKILLS,
    fileCount: manifest.fileCount,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const result = await build(args);
console.log(JSON.stringify(result, null, 2));
