#!/usr/bin/env node
/**
 * Convert markdown to PDF using Electron printToPDF + marked.
 * Usage: npx electron scripts/md-to-pdf-electron.cjs <input.md> <output.pdf>
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { marked } = require("marked");

const inputPath = path.resolve(process.argv[2] || "");
const outputPath = path.resolve(process.argv[3] || "");

if (!inputPath || !outputPath) {
  console.error("Usage: electron scripts/md-to-pdf-electron.cjs <input.md> <output.pdf>");
  process.exit(1);
}

const CSS = `
  @page { margin: 2cm; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    font-size: 11pt;
    line-height: 1.65;
    color: #1a1a2e;
    max-width: 100%;
  }
  h1 { font-size: 22pt; color: #161624; border-bottom: 2px solid #3d5afe; padding-bottom: 0.3em; margin-top: 0; }
  h2 { font-size: 15pt; color: #252540; margin-top: 1.4em; page-break-after: avoid; }
  h3 { font-size: 12pt; color: #333355; page-break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; }
  th { background: #f0f2ff; }
  code { background: #f4f4f8; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f4f4f8; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 9pt; }
  blockquote { border-left: 4px solid #3d5afe; margin-left: 0; padding-left: 1em; color: #555; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  strong { color: #161624; }
`;

function buildHtml(md) {
  const body = marked.parse(md, { gfm: true, breaks: false });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>智能工作台</title>
  <style>${CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

app.whenReady().then(async () => {
  const md = fs.readFileSync(inputPath, "utf8");
  const htmlPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.html`);
  fs.writeFileSync(htmlPath, buildHtml(md), "utf8");

  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });

  await win.loadFile(htmlPath);
  await new Promise((r) => setTimeout(r, 500));

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: "A4",
    margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
  });

  fs.writeFileSync(outputPath, pdf);
  fs.unlinkSync(htmlPath);
  console.log(`Wrote ${outputPath}`);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
