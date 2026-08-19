#!/usr/bin/env node
const fs = require("fs");
const manifest = {
  "createdAt": "2026-07-26T14:01:03.370Z",
  "base": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs",
  "moved": [
    {
      "id": "pandoc",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/pandoc/bin/pandoc",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/pandoc/bin/pandoc.broken-by-codex-20260726140103"
    },
    {
      "id": "ffmpeg",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/ffmpeg/bin/ffmpeg",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/ffmpeg/bin/ffmpeg.broken-by-codex-20260726140103"
    },
    {
      "id": "ffprobe",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/ffmpeg/bin/ffprobe",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/ffmpeg/bin/ffprobe.broken-by-codex-20260726140103"
    },
    {
      "id": "pillow",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/pillow/PIL",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/pillow/PIL.broken-by-codex-20260726140103"
    },
    {
      "id": "large-document-fitz",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/large-document/fitz",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/large-document/fitz.broken-by-codex-20260726140103"
    },
    {
      "id": "large-document-duckdb",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/large-document/duckdb",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/large-document/duckdb.broken-by-codex-20260726140103"
    },
    {
      "id": "pro-pdf-docling",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/pro-pdf/docling",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/pro-pdf/docling.broken-by-codex-20260726140103"
    },
    {
      "id": "web-automation-browsers",
      "source": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/web-automation/browsers",
      "dest": "/Users/zhangqin/Library/Application Support/lily-workbench/runtime-packs/web-automation/browsers.broken-by-codex-20260726140103"
    }
  ],
  "skipped": []
};
for (const item of manifest.moved) {
  if (fs.existsSync(item.source)) {
    console.log("skip existing", item.source);
    continue;
  }
  if (!fs.existsSync(item.dest)) {
    console.log("missing backup", item.dest);
    continue;
  }
  fs.renameSync(item.dest, item.source);
  console.log("restored", item.source);
}
