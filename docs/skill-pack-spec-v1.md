# 智能工作台 Skill Pack 规范 v1（草稿）

> 状态：草稿（已一轮审阅） · 适用于智能工作台 0.1.x 及后续版本  
> 目标：定义可内置、可远程下载、可校验的技能包格式，与 Claude Code `SKILL.md` 习惯兼容。  
> 关联 PRD：[skill-center-prd.md](./skill-center-prd.md)

---

## 1. 设计原则

1. **零客户依赖**：技能默认只使用应用内置 Node（`runtime-bin/node`），不要求 Python、npm 全局安装。
2. **声明式 manifest**：机器读 `skill.manifest.json`，模型读 `SKILL.md`。
3. **可合并**：多个技能合并生成一份 `CLAUDE.md`，禁止在应用代码里按 id 硬编码段落。
4. **可校验**：远程包必须带 `sha256`；生产环境建议 Ed25519 签名。
5. **可回滚**：保留上一版本目录，支持「恢复默认 / 回退版本」。

---

## 2. 术语

| 术语 | 含义 |
|------|------|
| Skill Pack | 一个技能目录或 `.skillpack.zip` 包 |
| Registry | 远程技能目录 JSON，列出可下载版本 |
| 内置技能 | 随安装包放在 `resources/skills/` 的技能 |
| 用户技能 | 下载或手动安装到用户数据目录的技能 |
| 占位符 | 安装时替换的路径/token，如 `{{NODE_BIN}}` |

---

## 3. 目录结构

### 3.1 解压后的 Skill Pack

```
<skill-id>/
├── skill.manifest.json    # 必需
├── SKILL.md               # 必需（Claude Code 兼容 frontmatter）
├── scripts/               # 可选，Node 脚本
│   └── *.cjs | *.js
├── assets/                # 可选，静态资源
└── LICENSE                # 可选
```

约束：

- `skill-id` 必须与 manifest 中 `id` 一致。
- 只允许相对路径；禁止 `..`、绝对路径、符号链接指向包外。
- 单包解压后总大小默认 ≤ **10 MB**（可在 registry 中单独声明更大上限）。
- v1 **禁止**包内携带 `node_modules/`；依赖必须 vendored 进单个脚本或随应用升级。

### 3.2 应用内路径（规划）

| 路径 | 用途 |
|------|------|
| `{appResources}/resources/skills/<id>/` | 出厂内置（只读） |
| `{userData}/claude-config/skills/<id>/` | 当前生效副本 |
| `{userData}/skills-state.json` | 启用状态、版本、来源 |
| `{userData}/skills-cache/` | 下载的 `.skillpack.zip` |
| `{userData}/skills-backup/<id>/<version>/` | 回滚用 |

`agentConfigDir()`  today 对应 `{userData}/claude-config/`。

---

## 4. skill.manifest.json

### 4.1 完整示例

```json
{
  "schemaVersion": 1,
  "id": "excel-read",
  "name": "Excel 分析",
  "version": "1.2.0",
  "description": "读取 xlsx/csv，输出表格预览与基础统计。",
  "author": "智能工作台团队",
  "license": "MIT",
  "minAppVersion": "0.1.0",
  "maxAppVersion": null,
  "channel": "stable",
  "runtime": "node",
  "entry": "scripts/excel-read.cjs",
  "placeholders": {
    "{{EXCEL_SCRIPT}}": "scripts/excel-read.cjs"
  },
  "env": [],
  "allowedTools": ["Bash"],
  "replaceNativeTools": [],
  "permissions": {
    "network": false,
    "filesystem": "read",
    "subprocess": "entry-only"
  },
  "claudeMd": {
    "title": "Excel 分析",
    "priority": 50,
    "body": "遇到 .xlsx / .csv 且需要读表时，不要用 Read 直接读二进制。执行：\n\n```\n\"{{NODE_BIN}}\" \"{{EXCEL_SCRIPT}}\" \"<文件绝对路径>\" --preview 30\n```\n\n脚本 stdout 为 JSON，包含 sheet 名、列名、样例行。"
  },
  "integrity": {
    "sha256": "可选，单文件包内 manifest 自描述时可省略"
  }
}
```

### 4.2 字段说明

| 字段 | 必需 | 说明 |
|------|------|------|
| `schemaVersion` | 是 | 固定 `1` |
| `id` | 是 | `[a-z0-9-]{2,64}`，全局唯一；内置 id 见 §7 |
| `name` | 是 | 技能中心展示名 |
| `version` | 是 | SemVer `MAJOR.MINOR.PATCH` |
| `description` | 是 | 一行摘要 |
| `minAppVersion` | 是 | 最低应用版本 |
| `runtime` | 是 | v1 仅允许 `"node"` |
| `entry` | 条件 | `runtime=node` 时必需，相对路径 |
| `placeholders` | 否 | 除 `{{NODE_BIN}}` 外自定义占位符 |
| `env` | 否 | 需要的 env 键名（不含 secret 值） |
| `allowedTools` | 否 | 提示模型可用工具，默认 `["Bash"]` |
| `replaceNativeTools` | 否 | 若声明则合并进 `disallowedTools`，如 `WebSearch` |
| `permissions.network` | 是 | 是否访问外网 |
| `permissions.filesystem` | 是 | `none` / `read` / `readwrite` |
| `permissions.subprocess` | 是 | v1 固定 `entry-only`：只能跑 manifest.entry |
| `claudeMd.title` | 是 | 写入 CLAUDE.md 的章节标题 |
| `claudeMd.priority` | 否 | 数字越小越靠前，默认 100 |
| `claudeMd.body` | 是 | Markdown 正文，可含占位符 |

### 4.3 SKILL.md 要求

保留 Claude Code 风格 frontmatter，并与 manifest 一致：

```markdown
---
name: excel-read
description: 读取 Excel/CSV 并输出结构化预览。
allowed-tools: Bash(node *)
---

# Excel 分析

（人类可读说明，可与 claudeMd.body 内容相近或更详细）
```

安装时：

1. 复制整个目录到 `claude-config/skills/<id>/`
2. 替换 `SKILL.md` 与 manifest 中所有 `{{PLACEHOLDER}}`
3. 系统占位符：`{{NODE_BIN}}` → `runtime-bin/node` 绝对路径

### 4.4 SKILL.md 与 claudeMd.body 的分工

| 载体 | 读者 | 用途 |
|------|------|------|
| `SKILL.md` | Claude Code 技能目录扫描 | 与上游 Skill 生态兼容；含 frontmatter |
| `claudeMd.body` | 合并进 `CLAUDE.md` | 本应用**主路径**：全局说明、跨技能排序、禁用开关 |

**v1 约定：**

- 运行时以 **`claudeMd.body` 合并结果为准**（禁用技能时不写入 CLAUDE.md）。
- `SKILL.md` 仍必需，便于调试、与 Claude Code 工具链一致；内容可与 `claudeMd.body` 相近，但不必字节级相同。
- 迁移内置技能时：把现有 `buildClaudeMd()` 段落迁入各 manifest 的 `claudeMd.body`；`SKILL.md` 保留人类可读说明即可。

---

## 5. 占位符规范

| 占位符 | 提供者 | 说明 |
|--------|--------|------|
| `{{NODE_BIN}}` | 应用 | 内置 Node shim，所有技能可用 |
| `{{SKILL_DIR}}` | 应用 | 当前技能安装目录绝对路径 |
| `{{USER_DATA}}` | 应用 | 应用 userData 根目录 |
| 自定义 | manifest.placeholders | 映射到包内相对路径的绝对路径 |

规则：

- 仅做字符串替换，不执行模板逻辑。
- `{{NODE_BIN}}`、`{{SKILL_DIR}}`、`{{USER_DATA}}` 由应用**始终注入**，无需写入 `manifest.placeholders`。
- 替换后的路径在 Windows 上使用双引号包裹（与现有 CLAUDE.md 一致）。

---

## 6. Registry 规范

### 6.1 registry.json

托管在 HTTPS（或企业内网）静态地址，例如：

`https://cdn.example.com/superhelper/skills/registry.json`

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-28T08:00:00Z",
  "publisher": "智能工作台官方",
  "registryUrl": "https://cdn.example.com/superhelper/skills/registry.json",
  "skills": [
    {
      "id": "excel-read",
      "name": "Excel 分析",
      "latestVersion": "1.2.0",
      "channel": "stable",
      "downloadUrl": "https://cdn.example.com/superhelper/skills/excel-read-1.2.0.skillpack.zip",
      "sha256": "abc123...",
      "signature": "base64-ed25519...",
      "minAppVersion": "0.1.0",
      "sizeBytes": 245760,
      "changelog": "支持多 Sheet 预览。"
    }
  ]
}
```

### 6.2 .skillpack.zip

- 压缩包根目录必须是 `<skill-id>/skill.manifest.json`（单层目录，禁止 zip slip）。
- 文件名建议：`<id>-<version>.skillpack.zip`
- 客户端下载后：校验 `sha256` → 可选验签 → 解压到临时目录 → 校验 manifest → 原子替换到 `skills/<id>/`

### 6.3 更新策略

| 类型 | 行为 |
|------|------|
| PATCH | 自动提示，用户一键更新 |
| MINOR | 提示更新，展示 changelog |
| MAJOR | 提示可能不兼容，需确认 |
| 内置技能 | 仅当用户点击「恢复出厂」时覆盖 |

---

## 7. 内置技能 ID（保留）

以下 id 为出厂内置，**第三方 registry 不得覆盖**，除非用户显式「替换内置」并二次确认：

| id | 名称 |
|----|------|
| `claude-vision` | 识图 |
| `websearch` | 联网搜索 |
| `webfetch` | 网页抓取 |

迁移要求：现有 `BUNDLED_SKILLS` 与 `buildClaudeMd()` 硬编码应迁移为本规范 manifest。

---

## 8. CLAUDE.md 合并规则

生成 `{userData}/claude-config/CLAUDE.md`：

1. 固定头部：`# 智能工作台全局说明`
2. 收集所有 **已启用** 技能的 `claudeMd.body`（占位符已替换）
3. 按 `claudeMd.priority` 升序排序
4. 章节格式：`## {claudeMd.title}`
5. 合并 **已启用** 技能的 `replaceNativeTools` 到 runner 的 `disallowedTools`（去重）

**产品级固定项（与技能无关）：** 本应用中 Claude 原生 `WebSearch` / `WebFetch` 不可用，runner **始终**传入 `--disallowed-tools WebSearch WebFetch`，与是否启用 `websearch` / `webfetch` 技能无关。禁用联网技能仅移除 CLAUDE.md 中的 Bash 替代说明，**不会**恢复原生工具。

触发重建时机：

- 应用启动（仅合并，不盲目覆盖用户技能）
- 安装 / 卸载 / 启用 / 禁用 / 更新技能后
- 用户点击「刷新技能配置」

---

## 9. 安全与审核

### 9.1 v1 禁止项

- 包内 `node_modules/`
- manifest 未声明的额外可执行文件被 Bash 调用（审计建议，非强制运行时拦截 v1）
- `runtime` 为 `python` / `shell`（v2 再议）
- 安装时自动 `npm install` / `pip install`

### 9.2 建议审核清单（上架前）

- [ ] manifest 与 SKILL.md 的 `name` / `description` 一致
- [ ] entry 脚本可在内置 Node 下 `--version` 或 `--help` 运行
- [ ] 无硬编码绝对路径
- [ ] `permissions.network=true` 时在技能中心明显标注
- [ ] 在 Windows + macOS 各测一次
- [ ] sha256 与 registry 一致

### 9.3 签名（推荐）

```
signingPayload = sha256(zipBytes)
signature = Ed25519.sign(signingPayload, publisherPrivateKey)
```

公钥内置在应用中；企业版可配置额外信任根。

---

## 10. 开发者工作流

### 10.1 本地打包

```bash
# 规划 CLI，v1 可用 zip 代替
cd excel-read
zip -r ../excel-read-1.2.0.skillpack.zip excel-read/
shasum -a 256 ../excel-read-1.2.0.skillpack.zip
```

### 10.2 本地调试

将技能目录复制到：

`~/Library/Application Support/terminal-chat-claude/claude-config/skills/<id>/`

手动执行 entry 验证：

```bash
"$(runtime-bin/node)" "./scripts/excel-read.cjs" "/path/to/test.xlsx"
```

### 10.3 上架流程（官方）

1. 代码审查 + 安全清单  
2. 打 zip，计算 sha256  
3. 更新 registry.json  
4. 客户端「检查更新」可见  

---

## 11. 与现有代码的差异（实施时注意）

| 现状 | 目标 |
|------|------|
| `BUNDLED_SKILLS` 硬编码 | 读 manifest + 内置目录 |
| `buildClaudeMd()` 按 id 分支 | 读 `claudeMd.body` 合并 |
| 每次启动覆盖 skills | 仅缺失或恢复默认时覆盖 |
| 每次启动覆盖 `settings.json` | 仅首次缺失时从 `resources/agent-defaults/` 写入 |
| `disallowedTools` 启动时算一次 | 随技能启用变化；变更后需重建 runner（见 PRD §5.1） |
| 无远程安装 | registry + skillpack 安装器 |

---

## 12. 审阅记录（2026-05-28）

| 项 | 结论 |
|----|------|
| 大依赖（如 xlsx） | 禁止 `node_modules`；用 esbuild 打成单文件 `.cjs` 或随应用升级 |
| registry 下载校验 | **registry 条目的 sha256 必填**；manifest 内 `integrity.sha256` 可选（用于离线二次校验） |
| zip 结构 | 包内必须是 `<id>/` 顶层目录，禁止 flat 文件根 |
| userData 路径 | 开发态多为 `~/Library/Application Support/terminal-chat-claude/`（package name）；安装包以 Electron `productName` 为准 |
| `permissions.subprocess=entry-only` | v1 为审核项，主进程不拦截 Bash；依赖模型遵守 + 官方包审查 |

---

## 13. 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v1 草稿 | 2026-05-28 | 初稿，Node-only，registry + zip |
| v1 审阅 | 2026-05-28 | 补 SKILL/claudeMd 分工、disallowedTools 产品约定、settings 覆盖 |

---

## 附录 A：内置技能 manifest 示例（迁移目标）

`claude-vision` 的 manifest 片段：

```json
{
  "id": "claude-vision",
  "name": "识图",
  "version": "1.0.0",
  "runtime": "node",
  "entry": "vision.js",
  "placeholders": { "{{VISION_SCRIPT}}": "vision.js" },
  "replaceNativeTools": [],
  "permissions": { "network": true, "filesystem": "read", "subprocess": "entry-only" },
  "claudeMd": {
    "title": "识图能力（必读）",
    "priority": 10,
    "body": "..."
  }
}
```

（完整 body 见当前 `agent-settings.js` 中 `buildClaudeMd()`，迁移时原样迁入 manifest。）
