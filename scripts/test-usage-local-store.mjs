#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-usage-test-"));
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => (name === "userData" ? tmpRoot : tmpRoot),
    },
  },
};

function loadUsageStore() {
  const configPath = path.join(__dirname, "../src/main/config.js");
  const storePath = path.join(__dirname, "../src/main/usage-local-store.js");
  delete require.cache[storePath];
  delete require.cache[configPath];
  delete require.cache[path.join(__dirname, "../src/main/usage-summary.js")];
  return require(storePath);
}

const store = loadUsageStore();
const storeFile = store.storePath();
if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile);

store.addUsageDelta({
  date: "2026-06-04",
  inputTokens: 1000,
  outputTokens: 500,
  messageCount: 2,
});

store.addUsageDelta({
  date: "2026-06-04",
  inputTokens: 2000,
  outputTokens: 1000,
  messageCount: 1,
});

const summary = store.getUsageSummary({ historyDays: 30 });
const day = summary.history.find((row) => row.date === "2026-06-04");
if (!day || day.inputTokens !== 3000 || day.outputTokens !== 1500 || day.messageCount !== 3) {
  throw new Error(`merged day record wrong: ${JSON.stringify(day)}`);
}

if (summary.pricingId !== "deepseek_x5") {
  throw new Error(`pricingId should be deepseek_x5, got ${summary.pricingId}`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("test-usage-local-store: ok");
