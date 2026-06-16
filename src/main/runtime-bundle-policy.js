"use strict";

const fs = require("node:fs");
const path = require("node:path");

const APP_ONLY_PYTHON_PACKAGES = new Map([
  ["akshare", "stock analysis app dependency"],
  ["tushare", "stock analysis app dependency"],
  ["longbridge", "stock analysis app dependency"],
  ["yfinance", "stock analysis app dependency"],
  ["finnhub", "stock analysis app dependency"],
  ["stockstats", "stock analysis app dependency"],
  ["tradingagents", "stock analysis app dependency"],
  ["lark_oapi", "workspace app integration dependency"],
  ["litellm", "app/runtime-pack LLM gateway dependency"],
  ["langchain", "agent app dependency"],
  ["langchain_core", "agent app dependency"],
  ["langgraph", "agent app dependency"],
  ["tavily", "third-party search app dependency"],
  ["serpapi", "third-party search app dependency"],
]);

function sitePackagesDir(runtimeRoot, platform) {
  if (platform === "win32-x64") {
    return path.join(runtimeRoot, "venv", "Lib", "site-packages");
  }
  const libDir = path.join(runtimeRoot, "venv", "lib");
  if (!fs.existsSync(libDir)) return null;
  const pythonDir = fs.readdirSync(libDir).find((name) => /^python\d+\.\d+$/.test(name));
  return pythonDir ? path.join(libDir, pythonDir, "site-packages") : null;
}

function packageEntryNames(packageName) {
  return [
    packageName,
    `${packageName}.py`,
    `${packageName.replace(/-/g, "_")}`,
    `${packageName.replace(/-/g, "_")}.py`,
  ];
}

function packageExists(sitePackages, packageName) {
  return packageEntryNames(packageName).some((name) => fs.existsSync(path.join(sitePackages, name)));
}

function findAppOnlyRuntimePackages(runtimeRoot, platform) {
  const sitePackages = sitePackagesDir(runtimeRoot, platform);
  if (!sitePackages || !fs.existsSync(sitePackages)) return [];
  const found = [];
  for (const [name, reason] of APP_ONLY_PYTHON_PACKAGES) {
    if (packageExists(sitePackages, name)) found.push({ name, reason });
  }
  return found;
}

module.exports = {
  APP_ONLY_PYTHON_PACKAGES,
  findAppOnlyRuntimePackages,
  sitePackagesDir,
};
