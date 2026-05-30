# 离线打包说明

将 Claude Code CLI 二进制放入对应平台目录，应用会使用**内置引擎**，不会读取用户本机 PATH 里的 `claude`，也不会共用 `~/.claude` 配置。

## 制作离线包

```bash
# 在有网络的同平台机器上先安装 Claude Code
npm install -g @anthropic-ai/claude-code

# macOS Apple Silicon
cp "$(which claude)" ./bundles/darwin-arm64/claude
chmod +x ./bundles/darwin-arm64/claude

# macOS Intel
cp "$(which claude)" ./bundles/darwin-x64/claude
chmod +x ./bundles/darwin-x64/claude

# Windows x64（在 Windows 或 CI 上获取）

在 Mac 上可用 **GitHub Actions** 自动构建（无需实体 Windows 电脑）：

1. 打开仓库 **Actions** → **Bundle Windows CLI** → **Run workflow**
2. 完成后下载 Artifact **win32-x64-claude-cli**
3. 解压得到 `claude.exe`，放到本仓库：

   ```
   bundles/win32-x64/claude.exe
   ```

4. 在 Mac 上打 Windows 安装包：

   ```bash
   npm run dist:win
   ```

或在 Windows 本机手动安装后复制（须为 **win32-x64 原生 PE**，不是 npm 下的 `.cmd` 包装）：

```powershell
npm install -g @anthropic-ai/claude-code
node "$(npm root -g)\@anthropic-ai\claude-code\install.cjs"
$native = "$(npm root -g)\@anthropic-ai\claude-code-win32-x64"
Copy-Item (Get-ChildItem $native -Recurse -Filter claude.exe | Select-Object -First 1).FullName .\bundles\win32-x64\claude.exe
```

# Linux x64
cp "$(which claude)" ./bundles/linux-x64/claude
chmod +x ./bundles/linux-x64/claude
```

## 目录结构

```
bundles/
├── darwin-arm64/
│   ├── engine-upstream          # 助手引擎（或 legacy claude）
│   └── runtime/                 # Python + uv + venv + LibreOffice（npm run build:runtime）
├── darwin-x64/
├── win32-x64/
└── linux-x64/

resources/
├── models.default.json          # 内置模型预设
└── runtime/requirements-runtime.txt
```

## 内置运行时（Python / Office）

技能里的 `python`、`uv`、`soffice` 默认走 `bundles/<平台>/runtime/`，不依赖用户本机环境。

```bash
# 在本机构建（需网络；macOS 会下载 LibreOffice DMG）
npm run build:runtime

# 仅 Python + 包，跳过 LibreOffice（约快 5 分钟）
node scripts/build-runtime-bundle.mjs --skip-libreoffice
```

跨平台可在 **Actions → Build Runtime Bundle** 下载 artifact，解压到对应 `bundles/<平台>/runtime/` 后再打安装包。

内置 venv 包含：pandas、openpyxl、markitdown、Pillow、python-docx、pypdf 等（见 `resources/runtime/requirements-runtime.txt`）。Playwright 仅安装 Python 包，**不含** Chromium 浏览器。


## 模型预设

编辑 `resources/models.default.json`，配置多套模型的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`。

用户可在 App 顶部下拉框切换；选择会保存到应用数据目录，不会写入用户 shell 环境。

## 运行逻辑

1. 启动时从 `bundles/<平台>/` 复制 CLI（仓库内仍为 `claude` / `claude.exe`）到应用数据 `claude-bin/`，安装后文件名为 **`lily-workbench.exe`（Windows）** 或 **`lily-workbench`（macOS/Linux）**，任务管理器中不再显示 `claude`
2. 子进程使用独立 `CLAUDE_CONFIG_DIR`（应用数据内）
3. 仅注入当前模型预设的环境变量，不继承用户 `ANTHROPIC_*`
4. **不会**使用用户本机已安装的 `claude`

## 开发调试

本机已有 Claude CLI、但未放入 `bundles/` 时：

```bash
npm run start:dev
```

会设置 `DEV_USE_SYSTEM_CLAUDE=1`，临时使用本机 CLI（不隔离，仅开发用）。

## 打安装包

```bash
npm run dist:mac    # macOS DMG/ZIP
npm run dist:win    # Windows NSIS/ZIP
npm run dist:all    # 同时打 Mac + Win
```

产物在 `dist/` 目录。
