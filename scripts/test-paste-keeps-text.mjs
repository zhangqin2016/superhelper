#!/usr/bin/env node
// Pasting a filesystem path into the composer must leave the characters in the
// box. Before 2026-09-15 the plain-text clipboard flavour was matched against
// the disk and, when it resolved, staged as an attachment while the paste
// handler returned early — so "/Users/me/shot.png" became an image chip and the
// text was gone. [gate: attachment-content-grounding]
// Run: node scripts/test-paste-keeps-text.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractClipboardFilePaths, stageClipboardFiles } = require("../src/main/ipc-files.js");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paste-keeps-text-"));
const png = path.join(tmp, "shot.png");
const doc = path.join(tmp, "case.docx");
fs.writeFileSync(png, "png");
fs.writeFileSync(doc, "docx");

try {
  check("a path pasted as text is not a file candidate; a real file copy still is", () => {
    const textOnly = { readText: () => png, availableFormats: () => ["text/plain"], readBuffer: () => Buffer.from("") };
    assert.deepEqual(extractClipboardFilePaths(textOnly), [png], "default (non-composer callers) is unchanged");
    assert.deepEqual(extractClipboardFilePaths(textOnly, { includePlainText: false }), [],
      "the composer's text paste must find nothing to attach");
    const realCopy = {
      readText: () => png,
      availableFormats: () => ["public.file-url", "text/plain"],
      readBuffer: (format) => (format === "public.file-url" ? Buffer.from(`file://${doc}\n`) : Buffer.from("")),
    };
    assert.deepEqual(extractClipboardFilePaths(realCopy, { includePlainText: false }), [doc],
      "copying a file in Finder/Explorer still attaches it");
  });

  check("staging passes the opt-out through", () => {
    const clip = { readText: () => png, availableFormats: () => [], readBuffer: () => Buffer.from("") };
    const manager = { stageFromPath: (p) => ({ id: p, path: p }) };
    assert.equal(stageClipboardFiles(manager, clip).files.length, 1, "other callers keep today's behaviour");
    const opted = stageClipboardFiles(manager, clip, { includePlainText: false });
    assert.deepEqual(opted.files, []);
    assert.equal(opted.empty, true);
  });

  check("the composer's paste handler opts out and always keeps the text", () => {
    const handler = fs.readFileSync(new URL("../src/renderer/modules/file-handler.js", import.meta.url), "utf8");
    const branch = handler.slice(handler.indexOf("if (!isComposerTextPaste(e)) return;"));
    assert.match(branch, /addSystemClipboardFiles\(\{ includePlainText: false \}\)/);
    assert.doesNotMatch(branch, /if \(systemFileCount > 0\) return;/,
      "the early return that discarded the pasted text must be gone");
    assert.ok(branch.indexOf("insertPlainTextAtCursor") > 0, "the text still reaches the box");
    const preload = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
    assert.match(preload, /includePlainText: options\?\.includePlainText !== false/);
    const ipc = fs.readFileSync(new URL("../src/main/ipc-files.js", import.meta.url), "utf8");
    assert.match(ipc, /ipcMain\.handle\("files:paste-clipboard", \(_event, options = \{\}\)/);
  });

  console.log(`\n${checks} checks passed (paste keeps text)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
