"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const layout = fs.readFileSync(path.join(root, "src/renderer/styles/layout.css"), "utf8");
const panelCss = fs.readFileSync(path.join(root, "src/renderer/styles/collaboration.css"), "utf8");
const teamsJs = fs.readFileSync(path.join(root, "src/renderer/modules/collaboration-teams.js"), "utf8");
const inboxJs = fs.readFileSync(path.join(root, "src/renderer/modules/collaboration-inbox.js"), "utf8");
const controllerPath = path.join(root, "src/renderer/modules/collaboration-panel-shell.js");

assert.ok(fs.existsSync(controllerPath), "right-panel presentation controller must exist");
assert.match(html, /id="collaborationPanelToggle"[^>]*aria-expanded="false"/, "top bar owns a collapsed collaboration toggle");
assert.match(html, /<aside[^>]+id="collaborationCenter"[^>]+hidden/, "collaboration is a default-hidden complementary panel");
assert.match(html, /id="collaborationPanelClose"/, "panel has an explicit close control");
assert.match(html, /id="collaborationPanelScrim"/, "overlay mode has a dismissible scrim");
assert.match(html, /id="collaborationHome"/, "panel exposes one home level");
assert.match(html, /id="collaborationConversation"[^>]+hidden/, "conversation detail is initially hidden");
assert.match(html, /id="collaborationConversationBack"/, "conversation detail has back navigation");
assert.doesNotMatch(html, /id="workbenchNavButton"/, "old full-surface workbench navigation is removed");
assert.ok(html.indexOf('id="collaborationCenter"') > html.indexOf('id="centerPanel"'), "panel follows the workbench in shell order");
assert.match(layout, /collaboration-panel-open/, "shell reserves panel width only while open");
assert.match(layout, /--collaboration-panel-w/, "docked width is a bounded custom property");
assert.match(panelCss, /data-collaboration-mode="overlay"/, "narrow windows use overlay presentation");
assert.doesNotMatch(panelCss, /grid-template-columns:\s*260px\s+minmax\(300px,\s*420px\)\s+minmax\(420px,\s*1fr\)/, "legacy three-column collaboration canvas is gone");
assert.match(teamsJs, /socialDisclosure\(/, "team creation is hidden behind a compact disclosure");
assert.match(inboxJs, /collaboration-row-avatar/, "conversation rows have an IM-style visual identity");
assert.match(panelCss, /\.collaboration-social-primary/, "panel owns polished primary-action styling");
assert.match(panelCss, /\.collaboration-disclosure/, "disclosed management forms have a dedicated compact treatment");
assert.match(panelCss, /\.collaboration-row-avatar/, "list avatars are styled consistently");

console.log("collaboration right panel structural contract passed");
const electron = require("electron");
if (electron && typeof electron !== "string" && electron.app?.quit) electron.app.quit();
