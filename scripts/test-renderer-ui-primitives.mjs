import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const stylesEntry = path.join(root, "src/renderer/styles.css");
const primitivePath = path.join(root, "src/renderer/styles/ui-primitives.css");
const composerPath = path.join(root, "src/renderer/styles/composer.css");
const messagesPath = path.join(root, "src/renderer/styles/messages.css");
const settingsPath = path.join(root, "src/renderer/styles/settings.css");
const runtimeChatPath = path.join(root, "src/renderer/styles/runtime-chat.css");
const topbarPath = path.join(root, "src/renderer/styles/topbar.css");
const customSelectPath = path.join(root, "src/renderer/modules/custom-select.js");

const stylesEntryText = fs.readFileSync(stylesEntry, "utf8");
if (!stylesEntryText.includes('@import "./styles/ui-primitives.css";')) {
  throw new Error("styles.css must import ui-primitives.css");
}

const primitiveText = fs.readFileSync(primitivePath, "utf8");
const composerText = fs.readFileSync(composerPath, "utf8");
const messagesText = fs.readFileSync(messagesPath, "utf8");
const settingsText = fs.readFileSync(settingsPath, "utf8");
const runtimeChatText = fs.readFileSync(runtimeChatPath, "utf8");
const topbarText = fs.readFileSync(topbarPath, "utf8");
const customSelectText = fs.readFileSync(customSelectPath, "utf8");
const appText = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
const indexText = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const permissionSettingsText = fs.readFileSync(path.join(root, "src/renderer/modules/permission-settings.js"), "utf8");
const turnBlockRendererText = fs.readFileSync(path.join(root, "src/renderer/modules/turn-block-renderers.js"), "utf8");
const pdfRendererText = fs.readFileSync(path.join(root, "src/renderer/modules/pdf-renderer.js"), "utf8");
const htmlRendererText = fs.readFileSync(path.join(root, "src/renderer/modules/html-renderer.js"), "utf8");
const findBarText = fs.readFileSync(path.join(root, "src/renderer/modules/find-bar.js"), "utf8");
const pdfViewerText = fs.readFileSync(path.join(root, "src/renderer/modules/pdf-viewer.js"), "utf8");
for (const required of [
  ".ui-btn",
  ".ui-btn-primary",
  ".ui-btn-danger",
  ".ui-icon-btn",
  ".ui-surface",
  ".ui-field",
  ".topbar-btn",
  ".settings-action-btn",
  ".assistant-action-btn",
]) {
  if (!primitiveText.includes(required)) {
    throw new Error(`ui-primitives.css is missing ${required}`);
  }
}

// Dialogs own their button primitive. Borrowing .send-btn (icon-only circle)
// or .topbar-btn (chrome control) broke dialog text when those evolved —
// the "确认放开" button clipped to a 34px circle.
if (!primitiveText.includes(".dialog-btn")) {
  throw new Error("ui-primitives.css is missing .dialog-btn");
}
{
  const modulesDir = path.join(root, "src/renderer/modules");
  const offenders = [];
  for (const entry of fs.readdirSync(modulesDir)) {
    if (!entry.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(modulesDir, entry), "utf8");
    if (/["'`= ]send-btn[ "'`]/.test(text) && !/send-btn-queued/.test(text)) {
      offenders.push(entry);
    }
  }
  if (offenders.length) {
    throw new Error(`send-btn is the composer's icon-only circle — dialogs must use .dialog-btn instead: ${offenders.join(", ")}`);
  }
}

function listCssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCssFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

const transitionAll = [];
for (const file of listCssFiles(path.join(root, "src/renderer/styles"))) {
  const text = fs.readFileSync(file, "utf8");
  const re = /transition\s*:\s*all\b/g;
  let match;
  while ((match = re.exec(text))) {
    const line = text.slice(0, match.index).split("\n").length;
    transitionAll.push(`${path.relative(root, file)}:${line}`);
  }
}

if (transitionAll.length) {
  throw new Error(`Avoid transition: all in renderer CSS:\n${transitionAll.join("\n")}`);
}

const permissionSelectRule = composerText.match(/\.permission-mode-select\s*\{[^}]*\}/s)?.[0] || "";
for (const required of ["appearance: none", "-webkit-appearance: none", "pointer-events: none"]) {
  if (!permissionSelectRule.includes(required)) {
    throw new Error(`permission-mode-select must not handle the composer popup directly: missing ${required}`);
  }
}
for (const required of ["id=\"sessionPermissionModeButton\"", "id=\"sessionPermissionModeMenu\"", "role=\"listbox\""]) {
  if (!indexText.includes(required)) {
    throw new Error(`composer session permission picker must use a lightweight DOM menu: missing ${required}`);
  }
}
for (const required of ["function syncSessionPermissionMenu", "toggleSessionPermissionMenu", "dispatchEvent(new Event(\"change\""]) {
  if (!permissionSettingsText.includes(required)) {
    throw new Error(`session permission DOM menu must stay wired to the existing select/change flow: missing ${required}`);
  }
}

const permissionWrapRule = composerText.match(/\.permission-mode-wrap::after\s*\{[^}]*\}/s)?.[0] || "";
if (!permissionWrapRule.includes('content: ""') || !permissionWrapRule.includes("rotate(45deg)")) {
  throw new Error("permission-mode-wrap must render a custom chevron instead of relying on native select chrome");
}
const composerRowRule = composerText.match(/(?:^|\n)\.composer-row\s*\{[^}]*\}/s)?.[0] || "";
if (!composerRowRule.includes("overflow: visible")) {
  throw new Error("composer-row must not clip the session permission menu");
}
const permissionMenuRule = composerText.match(/\.permission-mode-menu\s*\{[^}]*\}/s)?.[0] || "";
for (const required of ["width: min(230px", "border-radius: 10px", "box-shadow: 0 14px 34px"]) {
  if (!permissionMenuRule.includes(required)) {
    throw new Error(`permission-mode-menu must stay compact and polished: missing ${required}`);
  }
}
const permissionSelectedRule = composerText.match(/\.permission-mode-option\[aria-selected="true"\]\s*\{[^}]*\}/s)?.[0] || "";
if (!permissionSelectedRule.includes("background: color-mix") || !permissionSelectedRule.includes("var(--accent-subtle)")) {
  throw new Error("permission-mode selected option must use a subtle accent surface");
}

const latestHoverRule = messagesText.match(/\.scroll-to-bottom-btn:hover\s*\{[^}]*\}/s)?.[0] || "";
if (!latestHoverRule.includes("color: var(--text-primary)")) {
  throw new Error("Latest hover must keep readable text in light and dark themes");
}
if (latestHoverRule.includes("color: var(--text-inverse)")) {
  throw new Error("Latest hover must not use inverse text without a solid dark/accent background");
}

for (const [selector, token] of [
  [".topbar", "z-index: var(--z-topbar)"],
  [".update-popover", "z-index: var(--z-topbar-popover)"],
]) {
  const escaped = selector.replace(".", "\\.");
  const rule = topbarText.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "s"))?.[0] || "";
  if (!rule.includes(token)) {
    throw new Error(`${selector} must use centralized overlay stack token ${token}`);
  }
}

for (const required of [
  ".assistant-turn-narrative-text.markdown-body table",
  ".assistant-turn-narrative-text.markdown-body th",
  ".assistant-turn-narrative-text.markdown-body td",
]) {
  if (!runtimeChatText.includes(required)) {
    throw new Error(`live streaming markdown tables must use the same table chrome as final answers: missing ${required}`);
  }
}

const turnStatusRule = runtimeChatText.match(/(?:^|\n)\.assistant-turn-status\s*\{[^}]*\}/s)?.[0] || "";
for (const required of [
  "display: flex",
  "align-items: center",
  "min-height: 1.65em",
  "font-variant-numeric: tabular-nums",
  "font-feature-settings: \"tnum\"",
]) {
  if (!turnStatusRule.includes(required)) {
    throw new Error(`live turn status text must keep a stable baseline: missing ${required}`);
  }
}
for (const forbidden of ["animation:", "transform:"]) {
  if (turnStatusRule.includes(forbidden)) {
    throw new Error(`live turn status text must not animate or move vertically: found ${forbidden}`);
  }
}
const hiddenTurnStatusRule = runtimeChatText.match(/\.assistant-turn-status\[hidden\]\s*\{[^}]*\}/s)?.[0] || "";
if (!hiddenTurnStatusRule.includes("display: none !important")) {
  throw new Error("hidden live turn status must not leave a layout ghost");
}

for (const required of [
  ".assistant-reveal-btn",
  ".assistant-generated-file-row",
  ".assistant-renderer-artifact figcaption",
  ".assistant-generated-media-item",
]) {
  if (!runtimeChatText.includes(required)) {
    throw new Error(`runtime chat artifact UI must stay unified: missing ${required}`);
  }
}
for (const [label, text] of [
  ["turn-block-renderers", turnBlockRendererText],
  ["pdf-renderer", pdfRendererText],
  ["html-renderer", htmlRendererText],
]) {
  if (!text.includes("assistant-reveal-btn") || !text.includes("aria-label")) {
    throw new Error(`${label} must render reveal-in-folder as an icon button with an accessible label`);
  }
}
if (turnBlockRendererText.includes('button.textContent = t("file.reveal")')) {
  throw new Error("artifact reveal actions must not regress to large text buttons");
}
if (pdfRendererText.includes('makeAction(t("file.reveal")') || htmlRendererText.includes('makeAction(t("file.reveal")')) {
  throw new Error("PDF/HTML reveal actions must use the shared icon affordance, not a text action button");
}

if (!indexText.includes('class="settings-actions connector-form-actions settings-form-actions"')) {
  throw new Error("connector forms must put submit buttons in a dedicated footer action row");
}
for (const required of [".settings-page-actions", ".settings-form-actions", ".settings-action-btn--compact"]) {
  if (!settingsText.includes(required)) {
    throw new Error(`settings pages need shared action layout primitive ${required}`);
  }
}
if (!settingsText.includes(".settings-form-actions") || !settingsText.includes("justify-content: flex-end")) {
  throw new Error("settings form action rows must be visually separated and right-aligned");
}
for (const required of [
  'class="settings-actions settings-page-actions"',
  'class="settings-actions settings-form-actions"',
  'class="settings-actions connector-form-actions settings-form-actions"',
]) {
  if (!indexText.includes(required)) {
    throw new Error(`settings pages must use action layout classes consistently: missing ${required}`);
  }
}
for (const required of [
  ".connector-account-actions .settings-action-btn",
  ".model-custom-actions .settings-action-btn",
  ".settings-memory-actions .settings-action-btn",
  ".workspace-app-card-actions .settings-action-btn",
  ".runtime-pack-card-actions .settings-action-btn",
]) {
  if (!settingsText.includes(required)) {
    throw new Error(`settings row/card actions must use compact row-level button sizing: missing ${required}`);
  }
}

for (const [id, labelKey] of [
  ["addProjectBtn", "sidebar.addWorkspace"],
  ["leftToggleBtn", "topbar.toggleSidebar"],
  ["attachBtn", "composer.attach"],
  ["modelDiagnoseRestoreBtn", "settings.modelDiagnoseRestore"],
]) {
  const button = indexText.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`, "s"))?.[0] || "";
  if (!button) throw new Error(`missing icon button #${id}`);
  if (!button.includes(`data-i18n-title="${labelKey}"`) || !button.includes(`data-i18n-aria-label="${labelKey}"`)) {
    throw new Error(`#${id} must keep both tooltip and accessible label for its icon`);
  }
}
const updateCloseButton = indexText.match(/<button[^>]*id="updatePopoverCloseBtn"[^>]*>/s)?.[0] || "";
if (!updateCloseButton.includes('data-i18n-aria-label="composer.close"')) {
  throw new Error("update popover close icon must use localized aria label");
}
if (!findBarText.includes('setAttribute("aria-label", title)')) {
  throw new Error("find bar icon buttons must expose their title as aria-label");
}
for (const required of [
  "renderer.pdfPreviousMatch",
  "renderer.pdfNextMatch",
  "renderer.pdfZoomOut",
  "renderer.pdfZoomIn",
]) {
  if (!pdfViewerText.includes(required)) {
    throw new Error(`PDF viewer symbol buttons need scenario-specific labels: missing ${required}`);
  }
}

for (const required of ["initCustomSelects", "syncCustomSelects"]) {
  if (!appText.includes(required)) {
    throw new Error(`renderer app must wire custom select enhancement: missing ${required}`);
  }
}
for (const required of [
  "select.settings-select",
  "lily-select-source",
  "lily-select-button",
  "lily-select-menu",
  "dispatchEvent(new Event(\"change\"",
]) {
  if (!customSelectText.includes(required)) {
    throw new Error(`custom-select.js must keep native select as state source and render custom chrome: missing ${required}`);
  }
}
for (const required of [
  ".settings-select.lily-select-source",
  ".lily-select-button",
  ".lily-select-menu",
  "overflow-x: hidden",
  ".lily-select-option[aria-selected=\"true\"]",
]) {
  if (!settingsText.includes(required)) {
    throw new Error(`settings custom select CSS is incomplete: missing ${required}`);
  }
}
const visibleSettingsSelects = [...indexText.matchAll(/<select\b[^>]*class="([^"]*\bsettings-select\b[^"]*)"[^>]*>/g)];
if (visibleSettingsSelects.length === 0) {
  throw new Error("settings page should still expose select sources for existing settings flows");
}
const rendererJsFiles = [
  ...fs.readdirSync(path.join(root, "src/renderer/modules")).filter((file) => file.endsWith(".js")).map((file) => path.join(root, "src/renderer/modules", file)),
  path.join(root, "src/renderer/app.js"),
];
const nativeDialogs = [];
for (const file of rendererJsFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const re of [/window\.confirm\s*\(/g, /window\.alert\s*\(/g, /window\.prompt\s*\(/g]) {
    let match;
    while ((match = re.exec(text))) {
      const line = text.slice(0, match.index).split("\n").length;
      nativeDialogs.push(`${path.relative(root, file)}:${line}`);
    }
  }
}
if (nativeDialogs.length) {
  throw new Error(`renderer must use in-app dialogs instead of browser-native dialogs:\n${nativeDialogs.join("\n")}`);
}

console.log("renderer UI primitives guard: ok");
