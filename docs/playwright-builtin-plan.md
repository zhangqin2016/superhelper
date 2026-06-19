# 内置 Playwright + @playwright/mcp + Chromium（构建侧规格）

Date: 2026-06-19
决策：浏览器运行时**内置**（不按需下载），完全自包含——用户机器可能没有 Chrome。

## 现状

`bundles/<平台>/runtime/` 现在只含 **Python venv + uv + LibreOffice**，连 **node 都没有**
（`runtime/bin` 只有 python/python3/soffice/uv）。node 版 playwright 现在靠 runtime pack 下载。
本决策要把 **node + node-playwright + @playwright/mcp + Chromium** 一起打进 bundle。

## 约定的 bundle 布局（app 侧代码已按此实现）

```
bundles/<平台>/runtime/
  node/bin/node            # node 二进制（win32: node/node.exe）
  web/node_modules/playwright          # 执行器/扫描器用
  web/node_modules/@playwright/mcp/cli.js   # MCP server
  web/browsers/            # PLAYWRIGHT_BROWSERS_PATH（内置 Chromium）
```

## 构建侧改动（在构建机执行，本仓库未验证）

### 1. `scripts/build-runtime-bundle.mjs`

新增一段（每平台）：
- 下载/放置对应平台的 **node**（建议 node-build-standalone 或官方 tarball）到 `runtime/node/`。
- 在 `runtime/web/` 里 `npm install --no-save playwright @playwright/mcp`（锁定版本）。
- `PLAYWRIGHT_BROWSERS_PATH=runtime/web/browsers npx playwright install chromium`
  （只装 chromium，省体积）。
- 跨平台：mac 用目标 arch 的 node + chromium；win 用 win 包；构建机需能拉对应平台产物
  （或各平台各自构建，沿用现有 `build:runtime:win` 等分平台脚本）。

### 2. electron-builder（`package.json` build.extraResources）

`bundles/<平台>` 已整体进包，新增的 `runtime/node`、`runtime/web` 会自动随之打包。
**确认不要被 `!runtime/...` 排除**（现仅排除 libreoffice）。注意 asar：bundle 走 extraResources
（在 asar 外），可执行（node/chromium）需保持可执行权限。

### 3. `scripts/verify-runtime-bundle.mjs`

加断言（让构建流水线在缺失时**fail loud**）：
- `runtime/node/bin/node`（win: `runtime/node/node.exe`）存在且可执行；
- `runtime/web/node_modules/playwright` 与 `@playwright/mcp/cli.js` 存在；
- `runtime/web/browsers` 下有 chromium。

### 4. 体积

每平台约 **+150–300MB**（chromium 为主）。这是内置浏览器的预期代价，已确认接受。

## app 侧改动（本仓库已实现、已测、且 bundle 未到位时零影响）

- `src/main/mcp-config.js`：按上面布局生成 Claude CLI `--mcp-config`（bundled node 起
  @playwright/mcp，`--browser chromium --headless --isolated`，`PLAYWRIGHT_BROWSERS_PATH`
  指向内置 chromium，无任何凭据）。**门控**：node/mcp 不存在则返回 null。
- `src/main/bundle-locator.js`：`bundleRuntimeDir()` 定位 `bundles/<平台>/runtime`。
- `src/main/agent-session.js` `_spawn`：bundle 在则写 `mcp-active.json` 并加 `--mcp-config`；
  不在则**完全不加**（现有构建零影响）。
- `src/main/spawn-env.js`：bundle 在则把 `runtime/node/bin` 加进 PATH、设 `NODE_PATH`=内置
  node_modules、`PLAYWRIGHT_BROWSERS_PATH`=内置 chromium，让执行器/扫描器的前台 node/python
  工具也用内置浏览器；不在则 no-op。
- 测试：`scripts/test-mcp-config.mjs`（16，门控 + 配置形状 + 无凭据）。

## 浏览器启动策略（内置后）

内置 chromium 后，执行器/编译脚本 `chromium.launch()` 会经 `PLAYWRIGHT_BROWSERS_PATH` 用内置
chromium；扫描器现在 `channel="chrome"` 优先、chromium 兜底——内置后**应改为内置 chromium 优先**
（构建侧落地后同步调整 `scan_web_system.py` 的 launch 顺序）。

## 验收清单（构建机，每平台）

1. `npm run build:runtime`（含新 node/web 步骤）→ `verify-runtime-bundle` 全过。
2. 打包（`dist:mac:arm64` / `dist:win` …）→ 安装后检查 `Resources/bundles/<平台>/runtime/web` 在。
3. 真实站点跑一遍：发现契约 → 扫描(+HAR) → 生成技能 → 用 @playwright/mcp 做一次 a11y 操作 +
   执行器跑一次 API/浏览器动作 + 一次回退。确认内置 chromium 起得来、`--mcp-config` 被 CLI 接受。
