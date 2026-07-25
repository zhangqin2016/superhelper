#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const require = createRequire(import.meta.url);

const stylesEntry = read("src/renderer/styles.css");
const navigationImport = '@import "./styles/workspace-navigation.css";';
const navigationImportIndex = stylesEntry.indexOf(navigationImport);
const layoutImportIndex = stylesEntry.indexOf('@import "./styles/layout.css');
const systemImportIndex = stylesEntry.indexOf('@import "./styles/system.css');

assert.notEqual(navigationImportIndex, -1, "workspace navigation stylesheet is imported");
assert.ok(
  navigationImportIndex > layoutImportIndex,
  "workspace navigation stylesheet loads after layout.css",
);
assert.ok(
  navigationImportIndex < systemImportIndex,
  "workspace navigation stylesheet loads before system.css",
);

const navigationCss = read("src/renderer/styles/workspace-navigation.css");
const navigationCssWithoutComments = navigationCss.replace(/\/\*[\s\S]*?\*\//g, "");
const requiredSelectors = [
  ".left-search-row",
  ".workspace-switcher-btn",
  ".project-header-main",
  ".workspace-drag-handle",
  ".workspace-drag-dots",
  ".workspace-drag-dot",
  ".workspace-order-marker",
  ".workspace-ordering",
  ".is-dragging",
  ".workspace-switcher-overlay",
  ".workspace-switcher-dialog",
  ".workspace-switcher-header",
  ".workspace-switcher-search",
  ".workspace-switcher-close",
  ".workspace-switcher-content",
  ".workspace-switcher-grid",
  ".workspace-switcher-card",
  ".workspace-switcher-recent-panel",
  ".workspace-switcher-session-row",
  ".workspace-switcher-search-group",
  ".workspace-switcher-search-result",
  ".workspace-switcher-session-status",
  ".is-keyboard-active",
  '[aria-busy="true"]',
  '[dir="rtl"]',
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const selector of requiredSelectors) {
  const selectorBoundary = new RegExp(
    `${escapeRegExp(selector)}(?=\\s|[,{.:#>+~\\[])`,
  );
  assert.match(
    navigationCssWithoutComments,
    selectorBoundary,
    `navigation CSS defines selector ${selector}`,
  );
}

assert.match(
  navigationCss,
  /\.left-search-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+34px/s,
  "sidebar search row reserves a fixed 34px switcher button column",
);
assert.match(
  navigationCss,
  /\.workspace-drag-handle\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/s,
  "drag handle has a stable 24px hit target",
);
assert.match(
  navigationCss,
  /\.left-panel\s*\{[^}]*container-type:\s*inline-size[^}]*container-name:\s*workspace-sidebar/s,
  "sidebar establishes a named inline-size container",
);
assert.match(
  navigationCss,
  /\.project-header-main\s*\{[^}]*min-height:\s*34px/s,
  "workspace header keeps a stable interactive height",
);
assert.match(
  navigationCss,
  /@container\s+workspace-sidebar\s*\(max-width:\s*220px\)[\s\S]*?\.project-header-main\s*\{[^}]*width:\s*100%/,
  "narrow sidebar gives the workspace name the full default row width",
);
assert.match(
  navigationCss,
  /@container\s+workspace-sidebar\s*\(max-width:\s*220px\)[\s\S]*?\.workspace-drag-handle\s*\{[^}]*position:\s*absolute[^}]*inset-inline-end:/,
  "narrow sidebar overlays the drag handle with logical positioning",
);
assert.match(
  navigationCss,
  /@container\s+workspace-sidebar\s*\(max-width:\s*220px\)[\s\S]*?\.project-actions\s*\{[^}]*position:\s*absolute[^}]*inset-inline-end:/,
  "narrow sidebar overlays project actions instead of consuming flex width",
);
assert.match(
  navigationCss,
  /@container\s+workspace-sidebar\s*\(max-width:\s*220px\)[\s\S]*?\.project-actions\s*\{[^}]*background:\s*var\(--bg-left\)/,
  "narrow project action overlay prevents workspace text from showing through",
);
assert.match(
  navigationCss,
  /\.project-tree\[data-filter-active="true"\]\s+\.workspace-drag-handle\s*\{[^}]*visibility:\s*hidden/s,
  "active filtering removes the drag handle from keyboard focus",
);
assert.match(
  navigationCss,
  /\.workspace-drag-dot\s*\{[^}]*width:\s*[^;]*2px[^}]*height:\s*[^;]*2px/s,
  "drag handle uses visible 2px dots",
);
assert.match(
  navigationCss,
  /\.workspace-order-marker\s*\{[^}]*height:\s*2px/s,
  "workspace insertion marker is a stable 2px line",
);
assert.match(
  navigationCss,
  /\.workspace-switcher-dialog\s*\{[^}]*width:\s*min\(720px,\s*calc\(100vw\s*-\s*32px\)\)/s,
  "space center uses the required bounded dialog width",
);
assert.match(
  navigationCss,
  /\.workspace-switcher-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  "desktop space center uses three columns",
);
assert.match(
  navigationCss,
  /@media\s*\(max-width:\s*620px\)[\s\S]*?\.workspace-switcher-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  "space center switches to two columns below 620px",
);
assert.match(
  navigationCss,
  /@media\s*\(max-width:\s*430px\)[\s\S]*?\.workspace-switcher-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  "space center switches to one column below 430px",
);
assert.match(
  navigationCss,
  /\.workspace-switcher-card-meta,\s*\.workspace-switcher-session-meta\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*font-size:\s*11px/s,
  "workspace and session metadata remain readable",
);
assert.match(
  navigationCss,
  /\.workspace-switcher-card-time,\s*\.workspace-switcher-session-time\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*font-size:\s*11px/s,
  "workspace and session timestamps remain readable",
);
assert.match(
  navigationCss,
  /\.workspace-switcher-session-status\.is-idle,[^{}]*\{[^}]*color:\s*var\(--text-secondary\)[^}]*font-size:\s*11px/s,
  "idle runtime status uses readable secondary text",
);
for (const [status, token] of [
  ["running", "--info-text"],
  ["done", "--success-text"],
  ["failed", "--danger-text"],
]) {
  assert.match(
    navigationCss,
    new RegExp(
      `\\.workspace-switcher-session-status\\.is-${status},[^{}]*\\{[^}]*color:\\s*var\\(${token.replace("--", "\\-\\-")}\\)`,
      "s",
    ),
    `${status} runtime status keeps its semantic color`,
  );
}
assert.match(
  navigationCss,
  /\.workspace-switcher-btn:focus-visible,\s*\.workspace-switcher-close:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)[^}]*outline-offset:\s*[12]px/s,
  "space center icon buttons have a solid focus outline",
);
assert.match(
  navigationCss,
  /\.project-header-main:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)[^}]*outline-offset:\s*[12]px/s,
  "workspace header button has a solid focus outline",
);
assert.doesNotMatch(
  navigationCssWithoutComments,
  /flex-direction:\s*row-reverse/,
  "RTL metadata follows the document direction without manual reversal",
);
assert.match(
  navigationCss,
  /\.workspace-switcher-recent-title\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s,
  "long recent-workspace titles wrap without overflowing",
);
assert.doesNotMatch(
  navigationCssWithoutComments,
  /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\s*\(/i,
  "workspace navigation CSS has no literal color functions or hex colors",
);

const namedColors = new Set(Object.keys(require("color-name")).map((name) => name.toLowerCase()));
const allowedColorKeywords = new Set(["transparent", "currentcolor", "inherit"]);
const findLiteralNamedColors = (rawValue) => {
  const value = rawValue
    .replace(/(["']).*?\1/g, "")
    .replace(/\burl\([^)]*\)/gi, "")
    .replace(/\bvar\([^)]*\)/gi, "")
    .replace(/\bcolor-mix\s*\(/gi, "(");
  return [...value.matchAll(/\b[a-z]+\b/gi)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => namedColors.has(word) && !allowedColorKeywords.has(word));
};

assert.deepEqual(findLiteralNamedColors("1px solid red"), ["red"]);
assert.deepEqual(findLiteralNamedColors("color-mix(in srgb, red, transparent)"), ["red"]);
assert.deepEqual(findLiteralNamedColors("var(--red) currentColor transparent inherit"), []);

const declarationValues = [];
const declarationPattern = /(?:^|[;{])\s*[-\w]+\s*:\s*([^;{}]+)/gm;
for (const match of navigationCssWithoutComments.matchAll(declarationPattern)) {
  declarationValues.push(match[1]);
}
for (const rawValue of declarationValues) {
  const literalNamedColors = findLiteralNamedColors(rawValue);
  assert.deepEqual(
    literalNamedColors,
    [],
    `workspace navigation declaration uses tokens instead of named colors: ${rawValue.trim()}`,
  );
}

assert.doesNotMatch(
  navigationCss,
  /letter-spacing\s*:\s*-\S+|font-size\s*:\s*[^;]*(?:vw|cqw)/i,
  "workspace navigation avoids negative tracking and viewport-scaled text",
);

const requiredLocaleKeys = [
  "common.close",
  "common.undo",
  "workspaceOrder.dragHandle",
  "workspaceOrder.moveTop",
  "workspaceOrder.moveUp",
  "workspaceOrder.moveDown",
  "workspaceOrder.position",
  "toast.workspaceOrderSaved",
  "toast.workspaceOrderFailed",
  "toast.switchWorkspaceFailed",
  "workspaceCenter.open",
  "workspaceCenter.title",
  "workspaceCenter.search",
  "workspaceCenter.close",
  "workspaceCenter.empty",
  "workspaceCenter.noResults",
  "workspaceCenter.noSessions",
  "workspaceCenter.recentSessions",
  "workspaceCenter.workspaces",
  "workspaceCenter.sessions",
  "workspaceCenter.unavailable",
  "workspaceCenter.untitledSession",
  "workspaceCenter.untitledWorkspace",
  "workspaceCenter.addWorkspace",
  "workspaceCenter.status.idle",
  "workspaceCenter.status.running",
  "workspaceCenter.status.done",
  "workspaceCenter.status.failed",
];

const expectedRecoveryMessages = {
  "zh-CN": {
    "toast.workspaceOrderFailed": "工作空间顺序保存失败，已恢复原顺序",
    "workspaceCenter.unavailable": "该项目已不可用，列表已刷新",
    "toast.switchWorkspaceFailed": "切换工作空间失败，请重试",
  },
  en: {
    "toast.workspaceOrderFailed": "Could not save workspace order; the previous order was restored",
    "workspaceCenter.unavailable": "That item is no longer available. The list was refreshed.",
    "toast.switchWorkspaceFailed": "Could not switch workspace. Please retry.",
  },
  ar: {
    "toast.workspaceOrderFailed": "تعذّر حفظ ترتيب مساحات العمل؛ تمت استعادة الترتيب السابق",
    "workspaceCenter.unavailable": "لم يعد هذا العنصر متاحاً. تم تحديث القائمة.",
    "toast.switchWorkspaceFailed": "تعذر تبديل مساحة العمل. أعد المحاولة.",
  },
};

for (const locale of ["zh-CN", "en", "ar"]) {
  const relativePath = `src/renderer/i18n/locales/${locale}.json`;
  const messages = JSON.parse(read(relativePath));

  for (const key of requiredLocaleKeys) {
    assert.equal(
      typeof messages[key],
      "string",
      `${locale} includes string translation ${key}`,
    );
    assert.ok(messages[key].trim(), `${locale} translation ${key} is not empty`);
  }

  assert.equal("ctx.pin" in messages, false, `${locale} removes ctx.pin`);
  assert.equal("ctx.unpin" in messages, false, `${locale} removes ctx.unpin`);
  for (const [key, expected] of Object.entries(expectedRecoveryMessages[locale])) {
    assert.equal(messages[key], expected, `${locale} uses the approved recovery copy for ${key}`);
  }
  assert.ok(
    messages["workspaceCenter.recentSessions"].includes("{name}"),
    `${locale} recent session title includes {name}`,
  );
  for (const placeholder of ["{name}", "{position}", "{total}"]) {
    assert.ok(
      messages["workspaceOrder.position"].includes(placeholder),
      `${locale} workspace position includes ${placeholder}`,
    );
  }
}

console.log("workspace-navigation-style: ok");
