import assert from "node:assert/strict";
import {
  buildPastedTextFileName,
  pastedTextByteLength,
  pastedTextToBuffer,
  shouldStagePastedText,
} from "../src/renderer/modules/file-handler.js";

assert.equal(shouldStagePastedText("short note"), false, "short text should paste into the composer");
assert.equal(shouldStagePastedText("   \n\t"), false, "blank text should not become an attachment");

const longAscii = "a".repeat(6000);
assert.equal(shouldStagePastedText(longAscii), true, "large character count should become an attachment");

const multibyteText = "明".repeat(4096);
assert.equal(pastedTextByteLength(multibyteText), 4096 * 3, "UTF-8 byte threshold should count multibyte text");
assert.equal(shouldStagePastedText(multibyteText), true, "large byte count should become an attachment");

const normalMultibyte = "明".repeat(100);
assert.equal(shouldStagePastedText(normalMultibyte), false, "normal multibyte snippets should stay editable");

const name = buildPastedTextFileName(new Date("2026-06-24T05:06:07"));
assert.equal(name, "pasted-text-20260624-050607.md");

const decoded = new TextDecoder().decode(pastedTextToBuffer("line1\r\nline2"));
assert.equal(decoded, "line1\nline2\n", "staged markdown should normalize line endings and end with newline");

console.log("large pasted text: ok");
