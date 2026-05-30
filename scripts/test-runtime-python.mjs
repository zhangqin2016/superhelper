#!/usr/bin/env node
/**
 * Runtime path resolution (no Electron app required).
 */
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const runtimePython = require(path.join(__dirname, "../src/main/runtime-python.js"));

const entries = runtimePython.getRuntimePathEntries();
const summary = runtimePython.getRuntimeSummary();

if (summary.available) {
  if (!entries.length) throw new Error("runtime available but path entries empty");
  console.log("runtime-python: ok", summary.manifest?.platform, entries.length, "path entries");
} else {
  console.log("runtime-python: ok (no bundle — run npm run build:runtime)");
}
