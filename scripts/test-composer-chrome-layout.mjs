#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const runtimeChatCss = await readFile(new URL("../src/renderer/styles/runtime-chat.css", import.meta.url), "utf8");

const composerToolbar = html.match(/<div class="composer-toolbar">([\s\S]*?)<\/div>\s*<button id="sendBtn"/)?.[1] || "";
assert.match(composerToolbar, /id="sessionRoleBanner"/, "character selector must be integrated into the composer toolbar");

const articleActionsRule = runtimeChatCss.match(/\.assistant-article-actions\s*{([\s\S]*?)}/)?.[1] || "";
assert.match(articleActionsRule, /width:\s*fit-content\s*;/, "assistant action controls must not stretch into a full-width strip");
// Anchored to the answer it belongs to: at the right margin the copy button floated
// between messages with no visible owner (whole-app UI audit, 2026-09-03).
assert.match(articleActionsRule, /justify-content:\s*flex-start\s*;/, "assistant action controls sit flush under their own answer");
assert.doesNotMatch(articleActionsRule, /margin-inline-start:\s*auto\s*;/, "and no longer float at the right margin");

console.log("composer-chrome-layout: ok");
