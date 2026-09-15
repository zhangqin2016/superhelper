#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const historicalContent = messages[0].parts[0].state.input.content;
  assert.doesNotMatch(historicalContent, /old paragraph the user removed/, "stale historical file body is removed before the model call");
  assert.match(historicalContent, /omitted from history.*read the current file/i, "sanitized history explains how to recover current content");

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
  assert.match(liveMessages[0].parts[0].state.input.content, /^\[lily: this earlier tool call succeeded/, "sanitized history says the call succeeded and forbids copying the marker");
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

  console.log("live-file-history-guard: ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
