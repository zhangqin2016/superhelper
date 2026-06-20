# 离线打包说明

应用使用**内置 OpenCode 引擎**，从 `bundles/<平台>/opencode/` 加载，不依赖用户本机环境，也不读取用户 PATH 里的任何引擎。

## 获取内置引擎

```bash
# 当前平台
node scripts/fetch-opencode-engine.mjs

# 指定平台（打跨平台包时）
node scripts/fetch-opencode-engine.mjs --platform darwin-arm64
node scripts/fetch-opencode-engine.mjs --platform darwin-x64
node scripts/fetch-opencode-engine.mjs --platform win32-x64

# 一次性拉全部平台
npm run engine:opencode:all
```

`npm run dist:mac` / `dist:win` 会在打包前自动拉取对应平台的 OpenCode 引擎，通常无需手动执行。

## 目录结构

```
bundles/
├── darwin-arm64/
│   ├── opencode/bin/opencode     # OpenCode 引擎
│   └── runtime/                  # Python + uv + venv + LibreOffice（npm run build:runtime）
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

编辑 `resources/models.default.json` 配置多套模型（base URL / API key / model）。应用会按协议自动适配 Anthropic 兼容或 OpenAI 兼容网关。

用户可在 App 顶部下拉框切换；选择会保存到应用数据目录，不会写入用户 shell 环境。

## 打安装包

```bash
npm run dist:mac    # macOS DMG/ZIP（仅 darwin-arm64 + darwin-x64 bundles）
npm run dist:win    # Windows NSIS/ZIP（仅 win32-x64）
npm run dist:all    # 同时打 Mac + Win（各平台只带自己的 bundles）
```

### Windows 完整包（含 Python / LibreOffice runtime）

在 Mac 上无法构建 `win32-x64/runtime`，请用 GitHub Actions：

1. 打开 **Actions** → **Windows Full Installer** → **Run workflow**
2. 可选：勾选 `skip_libreoffice` 可加快调试构建
3. 完成后下载 Artifact **windows-installer-full**（`.exe` + `.zip`）

产物在 `dist/` 目录。
