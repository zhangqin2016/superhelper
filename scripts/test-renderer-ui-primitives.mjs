import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const stylesEntry = path.join(root, "src/renderer/styles.css");
const primitivePath = path.join(root, "src/renderer/styles/ui-primitives.css");
const composerPath = path.join(root, "src/renderer/styles/composer.css");

const stylesEntryText = fs.readFileSync(stylesEntry, "utf8");
if (!stylesEntryText.includes('@import "./styles/ui-primitives.css";')) {
  throw new Error("styles.css must import ui-primitives.css");
}

const primitiveText = fs.readFileSync(primitivePath, "utf8");
const composerText = fs.readFileSync(composerPath, "utf8");
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
for (const required of ["appearance: none", "-webkit-appearance: none", "text-overflow: ellipsis"]) {
  if (!permissionSelectRule.includes(required)) {
    throw new Error(`permission-mode-select must avoid native popup styling and preserve text: missing ${required}`);
  }
}

const permissionWrapRule = composerText.match(/\.permission-mode-wrap::after\s*\{[^}]*\}/s)?.[0] || "";
if (!permissionWrapRule.includes('content: ""') || !permissionWrapRule.includes("rotate(45deg)")) {
  throw new Error("permission-mode-wrap must render a custom chevron instead of relying on native select chrome");
}

console.log("renderer UI primitives guard: ok");
