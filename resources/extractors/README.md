# Extractor tools

Runtime pack installation prefers bundled extractor binaries from this directory
after the app-provided `7zip-bin` binary and before falling back to system tools
and the JSZip fallback.

`7zip-bin` is packaged with the desktop app and unpacked outside Electron asar,
so ordinary ZIP runtime packs do not depend on PowerShell, Finder, or a user
installed 7zip. This directory is for optional extra or replacement tools such
as `7zz` and `bsdtar`.

Expected layout:

```text
resources/extractors/darwin-arm64/7zz
resources/extractors/darwin-x64/7zz
resources/extractors/win32-x64/7za.exe
resources/extractors/win32-x64/bsdtar.exe
```

The installer also checks `LILY_EXTRACTOR_TOOL_DIRS`, using the platform path
first and then the shared `resources/extractors` directory. Keep third-party
license files next to any bundled binary.
