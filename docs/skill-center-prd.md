# 技能中心 PRD（草稿）

> 状态：草稿（已一轮审阅） · 产品：智能工作台  
> 关联规范：[skill-pack-spec-v1.md](./skill-pack-spec-v1.md)  
> 目标读者：产品、前端、主进程开发

---

## 1. 背景与问题

当前技能（识图、联网搜索、网页抓取）：

- 写死在 `src/main/agent-settings.js` 的 `BUNDLED_SKILLS`
- 启动时 `installAgentDefaults()` 覆盖 `claude-config/skills/` 与 `CLAUDE.md`
- 用户无法在 UI 中查看、开关或更新技能
- 无法从网络安装符合规范的新技能（如 Excel 分析）

**技能中心**提供统一入口：列出技能、启用/禁用、检查更新、安装远程包。

---

## 2. 目标与非目标

### 2.1 目标（分阶段）

| 阶段 | 目标 |
|------|------|
| **P1** | UI 展示内置 3 技能 + 启用开关；修复「启动覆盖用户技能」 |
| **P2** | 远程 registry、下载 `.skillpack.zip`、安装与更新 |
| **P3** | 分类浏览、批量更新、企业私有 registry |

### 2.2 非目标（v1 不做）

- 开放任意用户上传技能到公网商店（仅官方/企业审核包）
- 技能内 `npm install` / Python 依赖
- 技能市场付费与账号体系
- 修改 Claude 引擎本身

---

## 3. 用户故事

| 角色 | 故事 | 优先级 |
|------|------|--------|
| 普通用户 | 我想看到当前有哪些能力（识图、搜索等），避免不知道能干什么 | P1 |
| 普通用户 | 我想临时关掉联网搜索（合规场景） | P1 |
| 管理员 | 我想从公司 CDN 拉技能包，员工一键更新 | P2 |
| 管理员 | 我想配置 registry URL，不用改安装包 | P2 |
| 开发者 | 我想按规范做一个 Excel 技能并内测分发 | P2 |
| 用户 | 更新失败后能回退上一版本 | P2 |

---

## 4. 信息架构

### 4.1 入口

- 位置：**左侧栏「设置」面板**内新增 Tab「技能中心」，或独立侧栏项「技能」
- 与「模型」「权限」同级，避免 buried

### 4.2 页面结构（P1）

```
技能中心
├── 顶栏：检查更新（P2） | 刷新配置
├── 已安装（列表）
│   ├── [内置] 识图          v1.0.0   已启用  [开关]
│   ├── [内置] 联网搜索      v1.0.0   已启用  [开关]
│   └── [内置] 网页抓取      v1.0.0   已启用  [开关]
└── 说明脚注：技能会写入 AI 使用说明（CLAUDE.md）
```

### 4.3 页面结构（P2 扩展）

```
技能中心
├── Registry 来源：官方（可配置）
├── 有更新 (2)  ← badge
├── 已安装
│   ├── 识图 · 内置 · v1.0.0 · 已启用
│   ├── Excel 分析 · 远程 · v1.2.0 · 已启用 · [更新]
│   └── ...
├── 可安装（来自 registry，未安装）
│   └── PDF 摘要 · v1.0.0 · [安装]
└── 技能详情（抽屉）
    ├── 描述 / 权限（网络、读文件）
    ├── 版本历史 / changelog
    ├── [安装] [更新] [卸载] [恢复默认]
    └── 仅内置：恢复出厂版本
```

---

## 5. 功能说明

### 5.1 技能列表（P1）

**展示字段：**

- 名称、id、版本、来源（内置 / 远程 / 本地）
- 状态：已启用 / 已禁用
- 简短描述（manifest.description）

**操作：**

- 启用 / 禁用 toggle  
  - 禁用后：从 CLAUDE.md 合并中排除；**原生 WebSearch/WebFetch 仍保持 disallowed**（本应用不可用，见规范 §8）  
  - 生效范围：重建 `CLAUDE.md` 后，**下一条新消息**起模型按新说明执行；若当前 session 的 runner 已 spawn，需 `runnerPool.terminate(sessionId)` 后下次发消息才会带新 spawn 参数（与权限模式切换同策略）  
  - 若对话进行中（`runner.isBusy()`）：提示「请稍后再改」，与权限切换一致
- 刷新配置：强制重建 `CLAUDE.md`，并按需终止 idle runner 以便下次 spawn 刷新

**空态：** 无（P1 至少 3 个内置）

### 5.2 检查更新（P2）

1. 读取配置的 `registryUrl`（默认官方 CDN，可 `settings.json` 或独立 `skills-registry-config.json` 覆盖）
2. GET registry.json，缓存 `If-Modified-Since` / ETag
3. 与本地 `skills-state.json` 对比版本
4. 列表标记「可更新」；顶栏显示数量

失败处理：

- 无网：Toast「无法连接技能目录，请检查网络」
- 校验失败：不安装，保留当前版本，记录日志

### 5.3 安装 / 更新（P2）

流程：

```
下载 zip → sha256 校验 → 解压到临时目录 → 验证 manifest
→ 备份当前版本到 skills-backup/
→ 复制到 claude-config/skills/<id>/
→ 替换占位符 → 重建 CLAUDE.md → 更新 skills-state.json
```

更新过程中：

- 禁止切换技能开关（BUSY）
- 有会话 running 时：提示稍后（与模型切换一致）

### 5.4 卸载（P2）

- 远程技能：删除用户目录副本，从 state 移除
- 内置技能：不允许卸载，仅「禁用」或「恢复出厂」

### 5.5 恢复出厂（P1 内置 / P2 远程）

- 内置：从 `resources/skills/<id>` 重新复制，版本号恢复为内置 manifest
- 远程：从 `skills-backup/<id>/<version>` 回滚

---

## 6. 数据模型

### 6.1 skills-state.json

路径：`{userData}/skills-state.json`

```json
{
  "schemaVersion": 1,
  "registryUrl": "https://cdn.example.com/superhelper/skills/registry.json",
  "registryCachedAt": "2026-05-28T08:00:00Z",
  "skills": {
    "websearch": {
      "id": "websearch",
      "enabled": true,
      "source": "bundled",
      "installedVersion": "1.0.0",
      "bundledVersion": "1.0.0",
      "installedAt": "2026-05-28T00:00:00Z",
      "updatedAt": null
    },
    "excel-read": {
      "id": "excel-read",
      "enabled": true,
      "source": "remote",
      "installedVersion": "1.2.0",
      "bundledVersion": null,
      "installedAt": "2026-05-27T10:00:00Z",
      "updatedAt": "2026-05-28T08:00:00Z",
      "sha256": "abc..."
    }
  }
}
```

### 6.2 与 agentConfigDir 关系

| 文件 | 职责 |
|------|------|
| `claude-config/skills/<id>/` | Claude Code 读取的技能目录 |
| `claude-config/CLAUDE.md` | 合并后的全局说明 |
| `skills-state.json` | 应用层状态（启用、版本、来源） |

---

## 7. API 设计（IPC）

命名空间建议：`skills:*`，经 `preload.js` 暴露为 `assistantClient.*`。

### 7.1 P1

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `skills:list` | — | `{ ok, skills[] }` | 合并内置 + state |
| `skills:setEnabled` | `{ id, enabled }` | `{ ok, error? }` | 重建 CLAUDE.md |
| `skills:refresh` | — | `{ ok }` | 强制重建 CLAUDE.md |
| `skills:restoreBundled` | `{ id }` | `{ ok, error? }` | 恢复单个内置技能 |

`skills[]` 项：

```typescript
{
  id: string;
  name: string;
  description: string;
  version: string;
  source: "bundled" | "remote" | "local";
  enabled: boolean;
  permissions: { network: boolean; filesystem: string };
  canDisable: boolean;
  canRestore: boolean;
}
```

### 7.2 P2

| 方法 | 参数 | 返回 |
|------|------|------|
| `skills:checkUpdates` | — | `{ ok, updates[] }` |
| `skills:install` | `{ id, version? }` | `{ ok, error? }` |
| `skills:update` | `{ id }` | `{ ok, error? }` |
| `skills:uninstall` | `{ id }` | `{ ok, error? }` |
| `skills:setRegistryUrl` | `{ url }` | `{ ok }` |
| `skills:getRegistryUrl` | — | `{ ok, url }` |

错误码：

| error | 含义 |
|-------|------|
| `BUSY` | 有会话进行中 |
| `NOT_FOUND` | 技能或 registry 中无此 id |
| `CHECKSUM_MISMATCH` | sha256 不符 |
| `INVALID_MANIFEST` | 不符合规范 |
| `NETWORK` | 下载失败 |
| `BUNDLED_PROTECTED` | 不允许卸载内置 |

---

## 8. 主进程模块划分

```
src/main/
├── skill-manager.js       # 列表、启用、合并 CLAUDE.md
├── skill-installer.js     # P2: 下载、校验、解压、占位符
├── skill-registry.js      # P2: 拉 registry、缓存
└── agent-settings.js      # 重构：调用 skill-manager，去掉硬编码
```

**启动流程（目标）：**

```
bootstrapAgent()
  → ensureRuntimeNodeShim()
  → skillManager.ensureBundledPresent()   # 仅缺失时复制内置；禁止每次 rm 整目录
  → skillManager.mergeClaudeMd()
  → ensureSettingsPresent()               # 仅缺失时从 bundled 写 settings.json
  → agentDefaults.disallowedTools = skillManager.getDisallowedTools()
```

**现状对照（必须改）：** `installBundledSkill()` 当前每次 `fs.rmSync(skillTarget)` 后全量覆盖，与 P1 目标冲突；`installAgentDefaults()` 每次写 `settings.json`，会覆盖用户 API Key 配置。

---

## 9. UI 规范

### 9.1 列表项

- 左侧：技能名 + 来源标签（内置 / 官方远程）
- 右侧：Switch 启用
- 次要：版本号、权限图标（🌐 需网络、📁 读文件）

### 9.2 交互

- 点击行 → 详情抽屉（P2）
- 更新可用 → 行内橙色「更新」按钮
- 操作成功 → Toast；失败 → Toast + 可展开错误码

### 9.3 与设置面板一致

- 复用 `settings-panel` 的 sheet 样式
- ESC / 点击遮罩关闭
- 进行中会话禁止危险操作（与 `permissionModeSelect` 相同 BUSY 逻辑）

---

## 10. 内置技能初始数据（P1 展示用）

| 名称 | id | 版本 | 来源 | 默认 |
|------|-----|------|------|------|
| 识图 | claude-vision | 1.0.0 | 内置 | 启用 |
| 联网搜索 | websearch | 1.0.0 | 内置 | 启用 |
| 网页抓取 | webfetch | 1.0.0 | 内置 | 启用 |

说明文案（技能中心顶部）：

> 技能扩展了助手的工具能力。禁用后，AI 将不再收到该技能的使用说明。内置技能可在设置中恢复出厂版本。

---

## 11. 验收标准

### P1 Done

- [ ] 设置内打开技能中心，展示 3 个内置技能
- [ ] 禁用 websearch 后，新消息使用的 CLAUDE.md 不含联网 Bash 章节；runner 仍带 `--disallowed-tools WebSearch WebFetch`
- [ ] 启用/禁用后无需重启应用即可对新消息生效（或明确提示「下一条消息生效」并实现）
- [ ] 重启应用后，用户禁用状态保留，内置技能不被无故覆盖
- [ ] 恢复出厂可还原单个内置技能文件

### P2 Done

- [ ] 配置 registry URL 后可检查更新
- [ ] 安装远程 skillpack 后列表出现新技能，AI 可按 SKILL 使用
- [ ] sha256 错误时不安装
- [ ] 更新失败保留旧版本可用

---

## 12. 风险与依赖

| 风险 | 缓解 |
|------|------|
| 启动仍覆盖 skills | P1 必须先改 `installAgentDefaults` |
| 远程恶意包 | sha256 + 签名 + 官方 registry |
| CLAUDE.md 过长 | priority + 单技能 body 建议 < 2KB |
| 企业无公网 | 内网 registry URL 配置 |
| 与 Claude Code 升级不兼容 | manifest `minAppVersion`，skill 独立版本 |

**依赖：**

- [skill-pack-spec-v1.md](./skill-pack-spec-v1.md) 定稿
- 内置 3 技能补全 `skill.manifest.json`（迁移）
- CDN 或 Gitee Release 托管 registry + zip（P2）

---

## 13. 里程碑建议

| 里程碑 | 内容 | 预估 |
|--------|------|------|
| M1 | 规范定稿 + 迁移内置 manifest + skill-manager 合并 CLAUDE.md | 1 周 |
| M2 | 技能中心 P1 UI + IPC + 不覆盖启动逻辑 | 1 周 |
| M3 | registry + 安装器 + 首个远程技能（excel-read 内测） | 1～2 周 |
| M4 | 签名、回滚、企业 registry 配置 | 按需 |

---

## 14. 开放问题（审阅定案）

| # | 问题 | 定案 |
|---|------|------|
| 1 | registry 默认 URL | **P2 先用 Gitee Release**（与现有 GitHub/Gitee 双远程一致）；`registry.json` + zip 放 Release 资产；文档注明国内可直连 Gitee，GitHub 作 CI 镜像。企业版允许 `skills-state.json` / 设置页覆盖 URL。 |
| 2 | 禁用 websearch 是否恢复原生 WebSearch | **否**。始终 disallowed；禁用只去掉 Bash 替代说明。 |
| 3 | 技能变更何时生效 | **CLAUDE.md 立即重建**；runner **不强制杀进程**，但 busy 时禁止改；idle session 在 toggle 后 terminate runner，下一条消息 re-spawn。 |
| 4 | P1 是否展示 network 图标 | **是**。三个内置技能均需网络，应用图标 + tooltip「需要联网」。 |

---

## 15. 审阅记录（2026-05-28）

**与规范一致性：** 两份文档在 manifest、路径、IPC 命名上对齐；已修正 PRD 验收项与 `WebSearch` 的矛盾。

**P1 最小实现顺序建议：**

1. 内置 3 技能各加 `skill.manifest.json`（body 从 `buildClaudeMd()` 拆出）  
2. `skill-manager.js`：`mergeClaudeMd()` + `getDisallowedTools()` + `ensureBundledPresent()`  
3. 改 `installAgentDefaults()` → 调用 skill-manager，去掉硬编码分支  
4. `skills-state.json` 默认全启用；IPC + 设置 Tab UI  

**P2 前置：** 定稿 Gitee Release 目录结构；首个远程包建议 `excel-read`（esbuild 单文件 + CSV/xlsx 预览）。

**未写入 v1、可后续单列：** 技能依赖冲突检测、channel(beta) 过滤、JSON Schema 校验文件、多 registry 源。

---

## 附录：P1 原型文案（可直接进 UI）

**页面标题：** 技能中心  

**副标题：** 管理助手可用的扩展能力。更改后对新的对话生效。  

**空更新态（P2）：** 已是最新版本  

**检查更新失败：** 无法获取技能目录，请检查网络或联系管理员配置 registry 地址。
