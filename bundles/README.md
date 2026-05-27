# 离线打包说明

将 Claude Code CLI 二进制文件放入对应的平台目录，用户在没安装 CLI 的情况下也能使用本应用。

## 制作离线包

```bash
# 在有网络的同平台机器上先安装 Claude Code
npm install -g @anthropic-ai/claude-code

# 复制二进制到对应目录
# macOS Apple Silicon
cp $(which claude) ./bundles/darwin-arm64/claude

# macOS Intel
cp $(which claude) ./bundles/darwin-x64/claude

# Windows x64
# copy $(where claude) .\bundles\win32-x64\claude.exe

# Linux x64
cp $(which claude) ./bundles/linux-x64/claude
```

## 目录结构

```
bundles/
├── darwin-arm64/claude     # macOS Apple Silicon
├── darwin-x64/claude       # macOS Intel
├── win32-x64/claude.exe    # Windows x64
└── linux-x64/claude        # Linux x64
```

## 运行逻辑

应用启动时按以下顺序查找 Claude CLI：

1. 系统已安装的 claude（PATH / Homebrew / npm global）
2. `bundles/<当前平台>/` 下的离线包（自动复制到应用数据目录）
3. 在线自动安装（`npm install -g @anthropic-ai/claude-code`）
