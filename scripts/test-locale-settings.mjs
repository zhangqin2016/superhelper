#!/usr/bin/env node
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getLocale: () => "en-US",
      getSystemLocale: () => "en-US",
      getPath: () => "/tmp",
    },
  },
};

const { mapToSupportedLocale } = require(path.join(__dirname, "../src/main/locale-settings.js"));

const cases = [
  ["zh-CN", "zh-CN"],
  ["zh-Hans", "zh-CN"],
  ["zh_TW", "zh-CN"],
  ["en-US", "en"],
  ["en-GB", "en"],
  ["ar-SA", "ar"],
  ["ar", "ar"],
  ["fr-FR", "en"],
  ["", "en"],
];

for (const [input, expected] of cases) {
  const got = mapToSupportedLocale(input);
  if (got !== expected) {
    throw new Error(`mapToSupportedLocale(${JSON.stringify(input)}) = ${got}, want ${expected}`);
  }
}

console.log("locale-settings: ok", cases.length, "cases");
