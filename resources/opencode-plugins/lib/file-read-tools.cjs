"use strict";

/**
 * Which tools count as having read a file's CURRENT content.
 *
 * The live-file guard refuses an edit whose target has changed since the model
 * last saw it, which is right — an edit written against a stale view silently
 * reverts someone else's change. But it decided "you have read it" from a
 * hand-maintained list of two names, `read` and `read_file`, while the platform
 * classifies tools centrally. The list was both too narrow and partly wrong:
 * `notebookread` is a genuine file read and was missing, so reading a notebook
 * and then editing it was refused with no way to satisfy the guard, and
 * `read_file` is not a tool of this engine at all.
 *
 * A guard that cannot be satisfied is worse than no guard: the field report was
 * an agent reading a script it had just written, being refused the edit anyway,
 * and falling back to rewriting the file from a Python script — which is
 * exactly the unchecked write the guard exists to prevent.
 *
 * The names here mirror src/main/tool-semantics.js, where a tool whose
 * evidenceKind is `file_read` is one that returns a file's current content.
 * scripts/test-live-file-history-guard.mjs asserts the two agree, so a read
 * tool added upstream cannot silently start being refused here.
 *
 * Deliberately NOT included: bash (`cat` reads, but the same tool also writes,
 * so a bash call is no evidence the model saw the CURRENT bytes of this file)
 * and the extraction tools (they return a derived projection — an outline,
 * chunks, an OCR pass — not the text an edit must be written against).
 */
const FILE_READ_TOOLS = new Set(["read", "notebookread", "lsp"]);

/** The tool to name in an error, so being refused also tells you the way out. */
const SUGGESTED_READ_TOOL = "read";

function isFileReadTool(tool) {
  return FILE_READ_TOOLS.has(String(tool || "").toLowerCase());
}

module.exports = { FILE_READ_TOOLS, SUGGESTED_READ_TOOL, isFileReadTool };
