import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { turnReplayInput } = require("../src/main/turn-replay-input");
const source = { sessionId: "s", turnId: "t", userText: "Make a report", files: [{ path: "input.xlsx" }] };
assert.deepEqual(await turnReplayInput({}, "s", source), { content: source.userText, files: source.files, turnId: "t" });
const manager = { getTurnUserRevisionsAsync: async (sessionId, turnId) => {
  assert.equal(sessionId, "s"); assert.equal(turnId, "t");
  return [{ turnId: "t", text: "Wait; do not generate files", files: [{ path: "revision.txt" }] }, { turnId: "other", text: "WRONG TURN" }];
} };
const replay = await turnReplayInput(manager, "s", source);
assert.ok(replay.content.startsWith(source.userText));
assert.ok(replay.content.includes("Wait; do not generate files"));
assert.ok(!replay.content.includes("WRONG TURN"));
assert.equal(replay.files.length, 2);
assert.equal(source.userText, "Make a report", "original admission is immutable");
await assert.rejects(turnReplayInput(manager, "other", source), /SOURCE_UNAVAILABLE/);
await assert.rejects(turnReplayInput({ getTurnUserRevisionsAsync: async () => { throw Error("read failed"); } }, "s", source), /read failed/);
console.log("turn replay: durable revisions, owner isolation and read failure passed");
