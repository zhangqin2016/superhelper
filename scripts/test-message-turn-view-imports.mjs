#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/renderer/modules/message.js", import.meta.url),
  "utf8",
);

assert.match(source, /from "\.\/turn-view-renderer\.js"/, "message should keep using the article renderer for render functions");
assert.match(source, /from "\.\/turn-view-model\.js"/, "message should import turn model adapters directly");
assert.match(source, /from "\.\/turn-article-shell\.js"/, "message should import article shell directly");
assert.match(source, /from "\.\/turn-article-frame\.js"/, "message should import frame status updates directly");

const rendererImport = source.match(/import\s*\{([\s\S]*?)\}\s*from "\.\/turn-view-renderer\.js";/);
assert(rendererImport, "message should have a named turn-view-renderer import");
assert.doesNotMatch(rendererImport[1], /legacyLiveTurnFromMessage|liveTurnFromRecord|createLiveTurnArticleShell|refreshLiveTurnStatusDisplay/);
assert.match(rendererImport[1], /renderLiveTurnArticle/);
assert.match(rendererImport[1], /renderSealedTurnArticle/);

console.log("message-turn-view-imports: ok");
