import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stylesDir = path.join(root, "src", "renderer", "styles");
const baseCssPath = path.join(stylesDir, "base.css");
const indexHtmlPath = path.join(root, "src", "renderer", "index.html");
const themeModulePath = path.join(root, "src", "renderer", "modules", "theme-settings.js");

const rawColorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseCss = read(baseCssPath);
const lightThemeMatch = baseCss.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
assert(lightThemeMatch, "base.css must define a light theme block");
const lightTheme = lightThemeMatch[1];

for (const token of [
  "--color-scheme",
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-md",
  "--bg-surface-hover",
  "--bg-backdrop",
  "--text-inverse",
  "--success-bg",
  "--danger-bg",
  "--warning-bg",
  "--info-bg",
  "--diff-add-bg",
  "--code-bg",
  "--pre-bg",
  "--image-backdrop",
  "--scrollbar-thumb",
]) {
  assert(baseCss.includes(token), `base.css is missing theme token ${token}`);
}

assert(baseCss.includes(':root[data-text-size="large"]'), "base.css must define a large text-size block");

for (const warmToken of [
  "#f1f0ed",
  "#f7f6f3",
  "#fafaf7",
  "#fcfcfa",
  "#fffffd",
  "#f2f1ee",
  "#eae9e4",
]) {
  assert(!lightTheme.includes(warmToken), `light theme must not use warm paper token ${warmToken}`);
}

assert(lightTheme.includes("--bg-body: #f4f6f8;"), "light theme body should use neutral cool porcelain");
assert(lightTheme.includes("--bg-center: #fbfcfd;"), "light theme center should read clean white, not cream");
assert(lightTheme.includes("--bg-surface: #ffffff;"), "light theme surfaces should use true white");
assert(!/rgba\(52,\s*48,\s*40,/.test(lightTheme), "light theme must not use sepia brown overlay RGB");
assert(!/rgba\(46,\s*43,\s*36,/.test(lightTheme), "light theme shadows must not use warm brown RGB");

const selfReferencePattern = /^\s*(--[a-z0-9-]+):\s*var\(\1\)/gim;
const selfReferences = [...baseCss.matchAll(selfReferencePattern)].map((match) => match[1]);
assert(selfReferences.length === 0, `base.css contains token self references: ${selfReferences.join(", ")}`);

const styleFiles = fs
  .readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css") && name !== "base.css")
  .sort();

const rawColorFindings = [];
for (const fileName of styleFiles) {
  const filePath = path.join(stylesDir, fileName);
  const lines = read(filePath).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (rawColorPattern.test(line)) {
      rawColorFindings.push(`${fileName}:${index + 1}: ${line.trim()}`);
    }
  });
}

assert(
  rawColorFindings.length === 0,
  `Component CSS must use theme tokens, not raw colors:\n${rawColorFindings.join("\n")}`,
);

const indexHtml = read(indexHtmlPath);
assert(indexHtml.includes("lily.themeMode"), "index.html must apply persisted theme before CSS loads");
assert(indexHtml.includes("lily.textSizeMode"), "index.html must apply persisted text size before CSS loads");
assert(
  indexHtml.includes('./styles.css?v=20260713-light-theme'),
  "index.html must cache-bust the stylesheet entry after light theme token changes",
);
assert(indexHtml.includes("themeModeSelect"), "settings UI must expose the theme selector");
assert(indexHtml.includes("textSizeModeSelect"), "settings UI must expose the text-size selector");

const themeModule = read(themeModulePath);
assert(themeModule.includes("matchMedia"), "theme-settings.js must support system theme changes");
assert(themeModule.includes("document.documentElement"), "theme-settings.js must apply theme on documentElement");
assert(themeModule.includes("dataset.textSize"), "theme-settings.js must apply text size on documentElement");

console.log("theme token contract ok");
