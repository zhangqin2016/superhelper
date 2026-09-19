#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const pluginUrl = new URL("../resources/opencode-plugins/live-file-history-guard.js", import.meta.url);
assert.ok(fs.existsSync(pluginUrl), "live-file history guard plugin must exist");
const { LiveFileHistoryGuardPlugin } = await import(pluginUrl);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-live-file-guard-"));
const file = path.join(dir, "draft.md");
const sessionID = "session-live-file-test";

try {
  fs.writeFileSync(file, "current content after user deletion\n");
  const hooks = await LiveFileHistoryGuardPlugin({ directory: dir });
  const transform = hooks["experimental.chat.messages.transform"];
  const before = hooks["tool.execute.before"];
  const after = hooks["tool.execute.after"];

  assert.equal(typeof transform, "function", "history guard transforms model-bound messages");
  assert.equal(typeof before, "function", "history guard intercepts writes before execution");
  assert.equal(typeof after, "function", "history guard observes successful live reads");

  const messages = [{
    info: { role: "assistant", sessionID },
    parts: [{
      type: "tool",
      tool: "write",
      callID: "write-old",
      state: {
        status: "completed",
        input: {
          filePath: file,
          content: "current content after user deletion\nold paragraph the user removed\n",
        },
        output: "wrote file",
      },
    }],
  }];

  await transform({ sessionID }, { messages });
  const historicalState = messages[0].parts[0].state;
  // Contract change, 2026-09-19: the stale body is REMOVED, not replaced with an
  // explanation. Prose in the content slot is a plausible file body sitting
  // where file bodies go, and a field case has a `write` whose content is this
  // module's own placeholder copied verbatim — including its closing sentence,
  // the one that says never to copy it. An instruction inside the content slot
  // is read as content, because that is what the slot means.
  assert.equal(historicalState.input.content, undefined, "there is no body left in the content slot to copy");
  assert.equal("content" in historicalState.input, false, "the key itself is gone");
  assert.doesNotMatch(JSON.stringify(historicalState.input), /old paragraph the user removed/, "and the stale body is nowhere in the input");

  // What happened is said in the RESULT, where the model reads about a call
  // rather than reads its payload — and the original result is kept.
  const historicalOutput = String(historicalState.output || "");
  assert.match(historicalOutput, /removed from history/i, "the result says what happened");
  assert.match(historicalOutput, /read .*before editing or rewriting/i, "and how to recover the current content");
  assert.match(historicalOutput, /never copy this text into a file/i, "and that it is not material");

  await assert.rejects(
    before(
      { tool: "write", sessionID },
      { args: { filePath: file, content: "replacement without a fresh read\n" } },
    ),
    /LILY_LIVE_FILE_READ_REQUIRED/,
    "a stale historical snapshot cannot overwrite the live file before a current-turn read",
  );

  await after(
    { tool: "read", sessionID, args: { filePath: file } },
    { output: fs.readFileSync(file, "utf8") },
  );
  await before(
    { tool: "write", sessionID },
    { args: { filePath: file, content: "replacement after a fresh read\n" } },
  );

  // Same-size external edits must invalidate the previous read fingerprint.
  fs.writeFileSync(file, "different content, same byte length");
  await assert.rejects(
    before(
      { tool: "edit", sessionID },
      { args: { filePath: file, oldString: "different", newString: "updated" } },
    ),
    /LILY_LIVE_FILE_READ_REQUIRED/,
    "a later external change re-arms the read-before-write guard",
  );

  // Missing/unreadable paths fail open: a new file has no live content to lose.
  await before(
    { tool: "write", sessionID },
    { args: { filePath: path.join(dir, "new-file.md"), content: "new" } },
  );

  const missingPath = path.join(dir, "recover-me.md");
  const missingHistory = [{
    info: { role: "assistant", sessionID: "session-missing-file" },
    parts: [{
      type: "tool",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: missingPath, content: "only surviving historical copy" },
        output: "wrote file",
      },
    }],
  }];
  await transform({ sessionID: "session-missing-file" }, { messages: missingHistory });
  assert.equal(
    missingHistory[0].parts[0].state.input.content,
    "only surviving historical copy",
    "missing live files keep historical content so recovery remains possible",
  );

  const unchangedPath = path.join(dir, "unchanged.md");
  fs.writeFileSync(unchangedPath, "still current\n");
  const unchangedHistory = [{
    info: { role: "assistant", sessionID: "session-unchanged-file" },
    parts: [{
      type: "tool",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: unchangedPath, content: "still current\n" },
        output: "wrote file",
      },
    }],
  }];
  await transform({ sessionID: "session-unchanged-file" }, { messages: unchangedHistory });
  assert.equal(
    unchangedHistory[0].parts[0].state.input.content,
    "still current\n",
    "byte-identical historical writes remain available to the model",
  );

  process.env.LILY_LIVE_FILE_GUARD = "0";
  const disabledHistory = [{
    info: { role: "assistant", sessionID: "session-disabled-guard" },
    parts: [{
      type: "tool",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: unchangedPath, content: "old disabled snapshot" },
        output: "wrote file",
      },
    }],
  }];
  await transform({ sessionID: "session-disabled-guard" }, { messages: disabledHistory });
  assert.equal(disabledHistory[0].parts[0].state.input.content, "old disabled snapshot", "kill switch restores untouched history");
  await before(
    { tool: "write", sessionID: "session-disabled-guard" },
    { args: { filePath: unchangedPath, content: "allowed while disabled" } },
  );
  delete process.env.LILY_LIVE_FILE_GUARD;

  // 2026-09-14 field case: the engine hands the transform its LIVE message
  // objects; a pending (not yet executed) write must never be touched, and a
  // completed one must be sanitized on a COPY so the engine's stored history
  // and the original objects stay intact.
  const livePath = path.join(dir, "live.js");
  fs.writeFileSync(livePath, "export const v = 2;\n");
  const pendingPart = {
    type: "tool", tool: "write", callID: "write-pending",
    state: { status: "pending", input: { filePath: livePath, content: "export const v = 3;\n" } },
  };
  const completedPart = {
    type: "tool", tool: "write", callID: "write-old",
    state: { status: "completed", input: { filePath: livePath, content: "export const v = 1;\n" }, output: "wrote" },
  };
  const originalCompletedInput = completedPart.state.input;
  const liveMessage = { info: { role: "assistant", sessionID: "session-live-objects" }, parts: [completedPart, pendingPart] };
  const liveMessages = [liveMessage];
  await transform({ sessionID: "session-live-objects" }, { messages: liveMessages });
  assert.equal(pendingPart.state.input.content, "export const v = 3;\n", "a pending write keeps its real body (it has not executed yet)");
  assert.equal(originalCompletedInput.content, "export const v = 1;\n", "the original completed part object is never mutated in place");
  assert.equal(liveMessage.parts[0], completedPart, "the original message object is left untouched");
  assert.notEqual(liveMessages[0], liveMessage, "the model-bound list receives a sanitized COPY of the message");
  assert.equal(liveMessages[0].parts[0].state.input.content, undefined, "the sanitized copy has no body to copy");
  assert.match(String(liveMessages[0].parts[0].state.output || ""), /^[\s\S]*\[lily: elided the body of /, "and its result says what happened and forbids copying the marker");
  assert.equal(liveMessages[0].parts[1].state.input.content, "export const v = 3;\n", "the pending part is carried over unchanged in the copy");

  // Backstop: the marker itself can never become file content.
  await assert.rejects(
    before(
      { tool: "write", sessionID: "session-live-objects" },
      { args: { filePath: path.join(dir, "brand-new.js"), content: "[lily: historical snapshot omitted because x has a live filesystem version; read the current file before editing]" } },
    ),
    /LILY_LIVE_FILE_MARKER_REJECTED/,
    "writing the history placeholder to disk is refused even for a new file",
  );

  const runnerPool = fs.readFileSync(new URL("../src/main/session-runner-pool.js", import.meta.url), "utf8");
  assert.match(runnerPool, /live-file-history-guard\.js/, "the production runner loads the live-file guard");

  // A guard that cannot be satisfied is worse than no guard. The field report was
// an agent reading a script it had just written, being refused the edit anyway,
// and falling back to rewriting the file from a Python script — exactly the
// unchecked write this guard exists to prevent.
//
// The refusal used a hand-maintained list of two tool names while the platform
// classifies tools centrally, and that list was both too narrow (notebookread,
// a real file read, was missing) and partly fictional (read_file is not a tool
// of this engine). This keeps the two definitions from drifting apart again.
{
  const readTools = createRequire(import.meta.url)("../resources/opencode-plugins/lib/file-read-tools.cjs");
  const { resolveToolSemantics } = createRequire(import.meta.url)("../src/main/tool-semantics.js");
  const semanticsSource = fs.readFileSync(new URL("../src/main/tool-semantics.js", import.meta.url), "utf8");
  const declared = [...new Set((semanticsSource.match(/\["([a-z_0-9]+)",\s*\{/g) || [])
    .map((entry) => entry.match(/"([a-z_0-9]+)"/)[1]))];
  const platformReads = declared.filter((name) => resolveToolSemantics(name).evidenceKind === "file_read").sort();
  assert.deepEqual([...readTools.FILE_READ_TOOLS].sort(), platformReads,
    "the guard's idea of a file read must be the platform's — add it in tool-semantics and it is honoured here");
  assert.ok(readTools.isFileReadTool("notebookread"), "reading a notebook counts, and used to not");
  assert.ok(!readTools.isFileReadTool("read_file"), "a tool this engine does not have is not on the list");

  // bash can read a file, but the same tool writes; an extraction tool returns a
  // derived projection, not the bytes an edit must be written against.
  for (const name of ["bash", "lily_file_intelligence", "lily_document", "grep"]) {
    assert.ok(!readTools.isFileReadTool(name), `${name} is not proof the model saw the current bytes`);
  }

  // Being refused must also say how to stop being refused.
  const guard = fs.readFileSync(new URL("../resources/opencode-plugins/live-file-history-guard.js", import.meta.url), "utf8");
  assert.match(guard, /Read it with the .{0,2}\$\{SUGGESTED_READ_TOOL\}.{0,2} tool/, "the refusal names a tool that satisfies it");
  assert.match(guard, /does not clear this/, "and says which ways do not");
  assert.ok(readTools.FILE_READ_TOOLS.has(readTools.SUGGESTED_READ_TOOL), "and that tool is actually accepted");
  console.log("ok - the guard's read-tool set is the platform's, and a refusal names the way out");
}

console.log("live-file-history-guard: ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
