import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const stylesEntry = path.join(root, "src/renderer/styles.css");
const primitivePath = path.join(root, "src/renderer/styles/ui-primitives.css");
const composerPath = path.join(root, "src/renderer/styles/composer.css");
const messagesPath = path.join(root, "src/renderer/styles/messages.css");
const settingsPath = path.join(root, "src/renderer/styles/settings.css");
const systemPath = path.join(root, "src/renderer/styles/system.css");
const runtimeChatPath = path.join(root, "src/renderer/styles/runtime-chat.css");
const topbarPath = path.join(root, "src/renderer/styles/topbar.css");
const customSelectPath = path.join(root, "src/renderer/modules/custom-select.js");

const stylesEntryText = fs.readFileSync(stylesEntry, "utf8");
if (!/@import\s+"\.\/styles\/ui-primitives\.css(?:\?[^"]+)?";/.test(stylesEntryText)) {
  throw new Error("styles.css must import ui-primitives.css");
}
if (!/@import\s+"\.\/styles\/settings\.css\?v=20260716-motion";/.test(stylesEntryText)) {
  throw new Error("styles.css must cache-bust settings.css for the light theme button refresh");
}

const primitiveText = fs.readFileSync(primitivePath, "utf8");
const composerText = fs.readFileSync(composerPath, "utf8");
const messagesText = fs.readFileSync(messagesPath, "utf8");
const settingsText = fs.readFileSync(settingsPath, "utf8");
const systemText = fs.readFileSync(systemPath, "utf8");
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

// Disabled buttons must go neutral, and settings primary actions must remain
// readable outline controls rather than reintroducing white text on a fill.
{
  const settingsCss = fs.readFileSync(settingsPath, "utf8");
  const genericDisabled = settingsCss.match(/\.settings-action-btn:disabled[^{]*\{[^}]*\}/s)?.[0] || "";
  if (/opacity:\s*0?\.\d/.test(genericDisabled)) {
    throw new Error("settings-action-btn:disabled must not use opacity ghosting; it must use a neutral fill and readable text");
  }
  if (!genericDisabled.includes("color: var(--text-tertiary)") || !genericDisabled.includes("opacity: 1")) {
    throw new Error("settings-action-btn:disabled must use readable neutral text at full opacity");
  }
  const primaryDisabled = settingsCss.match(/\.settings-action-btn--primary:disabled[^{]*\{[^}]*\}/s)?.[0] || "";
  if (!primaryDisabled.includes("opacity: 1")) {
    throw new Error("settings-action-btn--primary:disabled must override the 0.45 opacity ghosting with a neutral fill");
  }
  if (!primaryDisabled.includes("border-color: var(--border-light)")) {
    throw new Error("settings-action-btn--primary:disabled must use a neutral border, not the accent border");
  }
  if (settingsCss.indexOf(".settings-action-btn--primary:disabled") < settingsCss.indexOf(".settings-action-btn--primary {")) {
    throw new Error("settings-action-btn--primary:disabled must be declared after the primary fill so it wins the cascade");
  }
  const primaryStyle = settingsCss.match(/\.settings-action-btn--primary\s*\{[^}]*\}/s)?.[0] || "";
  if (
    !primaryStyle.includes("background: color-mix(in srgb, var(--accent) 10%, var(--bg-input))") ||
    !primaryStyle.includes("color: var(--accent)") ||
    primaryStyle.includes("var(--text-inverse)") ||
    primaryStyle.includes("linear-gradient")
  ) {
    throw new Error("settings-action-btn--primary must use the readable outline treatment globally; filled white text is not allowed");
  }
  const primaryHover = settingsCss.match(/\.settings-action-btn--primary:hover[^}]*\{[^}]*\}/s)?.[0] || "";
  if (!primaryHover.includes("color: var(--accent)")) {
    throw new Error("settings-action-btn--primary hover state must keep readable accent text");
  }
  const workspacePrimaryDisabled = settingsCss.match(/\.workspace-app-card-actions\s+\.settings-action-btn--primary:disabled[^{]*\{[^}]*\}/s)?.[0] || "";
  if (!workspacePrimaryDisabled.includes("border-color: var(--border-light)")) {
    throw new Error("disabled workspace app primary actions must use a neutral border");
  }
  const workspaceOpenDisabled = settingsCss.match(/\.workspace-app-open:disabled,\s*\.workspace-app-download:disabled:not\(\[data-busy="1"\]\)\s*\{[^}]*\}/s)?.[0] || "";
  if (
    !workspaceOpenDisabled.includes("opacity: 1") ||
    !workspaceOpenDisabled.includes("border-color: var(--border-light)") ||
    !workspaceOpenDisabled.includes("color: var(--text-tertiary)")
  ) {
    throw new Error("disabled workspace app open buttons must render as neutral buttons, not ghosted primary buttons");
  }
  const finalPrimaryDisabled = systemText.match(/\.settings-action-btn--primary:disabled[^{]*\{[^}]*\}/s)?.[0] || "";
  if (
    !finalPrimaryDisabled.includes(":not([data-busy=\"1\"])") ||
    !finalPrimaryDisabled.includes("color: var(--text-tertiary) !important") ||
    !finalPrimaryDisabled.includes("opacity: 1 !important") ||
    !finalPrimaryDisabled.includes("border-color: var(--border-light) !important")
  ) {
    throw new Error("system.css must final-override disabled primary setting buttons to neutral after all imports while preserving busy buttons");
  }
  const finalWorkspaceOpenDisabled = systemText.match(/\.workspace-app-card-actions\s+\.settings-action-btn:disabled[^{]*\{[^}]*\}/s)?.[0] || "";
  if (
    !finalWorkspaceOpenDisabled.includes(".workspace-app-card-actions .workspace-app-open:disabled:not([data-busy=\"1\"])") ||
    !finalWorkspaceOpenDisabled.includes("color: var(--text-tertiary) !important") ||
    !finalWorkspaceOpenDisabled.includes("opacity: 1 !important") ||
    !finalWorkspaceOpenDisabled.includes("border-color: var(--border-light) !important")
  ) {
    throw new Error("system.css must final-override disabled workspace app open buttons after cached settings CSS");
  }
  const dialogPrimaryDisabled = primitiveText.match(/\.dialog-btn--primary:disabled\s*\{[^}]*\}/s)?.[0] || "";
  if (!dialogPrimaryDisabled.includes("opacity: 1")) {
    throw new Error("dialog-btn--primary:disabled must use a neutral fill, not opacity ghosting");
  }
  const sendDisabled = composerText.match(/\.send-btn:disabled\s*\{[^}]*\}/s)?.[0] || "";
  if (/opacity:\s*0?\.\d/.test(sendDisabled)) {
    throw new Error("send-btn:disabled must use a neutral fill, not opacity ghosting");
  }
}

{
  const workspaceAppsText = fs.readFileSync(path.join(root, "src/renderer/modules/workspace-apps.js"), "utf8");
  if (workspaceAppsText.includes('app.installedAvailable ? "settings-action-btn--primary" : ""')) {
    throw new Error("workspace app open button must not use primary styling; primary creates fragile white text on light backgrounds");
  }
  if (/workspace-app-download[^\n"]*settings-action-btn--primary|settings-action-btn--primary[^\n"]*workspace-app-download/.test(workspaceAppsText)) {
    throw new Error("workspace app create/update buttons must not use primary styling; use the dedicated outline style instead");
  }
  if (!workspaceAppsText.includes("workspace-app-open")) {
    throw new Error("workspace app open button must carry a stable class for its disabled neutral style");
  }
  const workspaceAppActionStyle = settingsText.match(/\.workspace-app-open,\s*\.workspace-app-download\s*\{[^}]*\}/s)?.[0] || "";
  if (!workspaceAppActionStyle.includes("color: var(--accent)") || !workspaceAppActionStyle.includes("font-weight: 650")) {
    throw new Error("workspace app primary row actions must share the dedicated readable outline style");
  }
  const mediaSaveStyle = settingsText.match(/\.media-save-btn\s*\{[^}]*\}/s)?.[0] || "";
  if (mediaSaveStyle.includes("var(--text-inverse)") || mediaSaveStyle.includes("linear-gradient")) {
    throw new Error("media save action must follow the global readable outline treatment instead of reintroducing white text");
  }
}

// Many generated file references must not become a long vertical wall. Compact
// artifacts flow in a bounded grid, while rich previews still span the full row.
{
  const artifactsGrid = runtimeChatText.match(/\.assistant-turn-artifacts\s*\{[^}]*\}/s)?.[0] || "";
  if (!artifactsGrid.includes("display: grid") || !artifactsGrid.includes("repeat(3, minmax(0, 1fr))")) {
    throw new Error("assistant turn artifacts must render compact file references in a three-column grid");
  }
  const fullSpan = runtimeChatText.match(/\.assistant-turn-artifacts\s*>\s*:not\(\.assistant-renderer-artifact\.is-compact\)\s*\{[^}]*\}/s)?.[0] || "";
  if (!fullSpan.includes("grid-column: 1 / -1")) {
    throw new Error("expanded artifact previews must span the full artifact grid");
  }
  const compactCaption = runtimeChatText.match(/\.assistant-renderer-artifact\.is-compact figcaption\s*\{[^}]*\}/s)?.[0] || "";
  if (!compactCaption.includes("grid-template-columns: minmax(0, 1fr) auto auto")) {
    throw new Error("compact artifact captions must keep filename, size, and reveal action in a stable grid");
  }
  const compactPath = runtimeChatText.match(/\.assistant-renderer-artifact\.is-compact \.assistant-generated-file-path\s*\{[^}]*\}/s)?.[0] || "";
  if (!compactPath.includes("text-overflow: ellipsis") || !compactPath.includes("white-space: nowrap")) {
    throw new Error("compact artifact filenames must truncate to keep the grid dense");
  }
  if (!turnBlockRendererText.includes('title=${name}>${name}</code>')) {
    throw new Error("compact artifact filenames must expose the full path in a title tooltip");
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
