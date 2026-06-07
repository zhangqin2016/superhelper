#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/settings-panel.js"),
  "utf8",
);

const clickHandlerMatch = source.match(/openBtn\.addEventListener\("click",\s*\(\)\s*=>\s*{([\s\S]*?)}\);/);
if (!clickHandlerMatch) {
  throw new Error("settings button click handler not found");
}

const clickHandler = clickHandlerMatch[1];
const openIndex = clickHandler.indexOf("setPanelOpen(true)");
const refreshIndex = clickHandler.indexOf("refreshSettingsPanelData()");

if (openIndex < 0 || refreshIndex < 0) {
  throw new Error("settings click should open the panel and then refresh data");
}
if (openIndex > refreshIndex) {
  throw new Error("settings panel must open before refreshing slow settings data");
}
if (/await\s+refresh/.test(clickHandler)) {
  throw new Error("settings click must not await refresh work before opening");
}

console.log("settings-panel-open-order: ok");
