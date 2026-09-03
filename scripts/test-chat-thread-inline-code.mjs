#!/usr/bin/env node
/**
 * Chat thread: inline code, the answer's action row, and the app logo.
 *
 * Seen in a rendered thread: `--parallel` broke after its hyphens into `--` /
 * `parallel`; five rust-coloured code chips in one sentence read as warnings;
 * the copy button sat at the right margin between two messages, so it could
 * belong to either; and an empty icon URL left a broken-image box beside the
 * word mark.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const css = read("src/renderer/styles/runtime-chat.css");

// ---- Inline code keeps a token whole, and is a word rather than a flag ----
{
  const rule = /\.assistant-turn-narrative\.markdown-body code,\s*\n\.assistant-turn-final\.markdown-body code \{([^}]*)\}/s.exec(css);
  assert.ok(rule, "the inline code rule exists");
  assert.match(rule[1], /white-space: nowrap/, "a token like --parallel does not break at its hyphens");
  assert.match(rule[1], /color: color-mix\(in srgb, var\(--text-primary\) 80%, var\(--code-text\) 20%\)/,
    "inline code is mostly body ink with a trace of the code hue");
  assert.doesNotMatch(rule[1], /color: var\(--code-text\);/, "the full rust colour is no longer the inline default");
  assert.match(css, /code\.is-long,\s*\n[^{]*code\.is-long \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/s,
    "a long span (a path, a command) may still wrap, so nothing overflows a narrow column");

  const markdown = read("src/renderer/modules/markdown.js");
  // The marker lives in its own module: markdown.js sits at its line ratchet.
  assert.match(read("src/renderer/modules/markdown-inline-code.js"), /const LONG_INLINE_CODE = 40;/, "the length past which inline code may wrap is one named number");
  assert.match(markdown, /import \{ markLongInlineCode \} from "\.\/markdown-inline-code\.js";/, "markdown.js uses the extracted marker");
  assert.match(read("src/renderer/modules/markdown-inline-code.js"), /if \(code\.closest\("pre"\)\) continue;/, "code blocks are left alone");
  assert.match(markdown, /\n  markLongInlineCode\(element\);\n/, "the marker runs on every rendered markdown element");
}

// ---- The action row belongs to its answer ------------------------------
{
  const rule = /\.assistant-article-actions \{([^}]*)\}/s.exec(css);
  assert.ok(rule, "the action row rule exists");
  assert.match(rule[1], /justify-content: flex-start/, "the row starts where the answer starts");
  assert.doesNotMatch(rule[1], /margin-inline-start: auto/, "it is no longer pushed to the right margin between messages");
}

// ---- No image, no box --------------------------------------------------
{
  const app = read("src/renderer/app.js");
  assert.match(app, /if \(!url\) \{[^}]*for \(const img of logos\) img\.hidden = true;/s, "without an icon URL the logo images are hidden");
  assert.match(app, /console\.warn\("\[app-icon\] failed to render logo"\);\s*\n\s*img\.hidden = true;/, "a failed load hides the image instead of leaving a broken box");
}

console.log("chat-thread-inline-code: ok");
