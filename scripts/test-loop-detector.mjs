#!/usr/bin/env node
/**
 * Result-aware doom-loop detector (supervision layer). Drives the real plugin's
 * tool.execute.after hook. WHY each assertion matters: the detector must catch a
 * tool spinning with NO progress (the "subtask runs 10 minutes" incident) WITHOUT
 * ever firing on legitimate work — so the result hash is part of the signature
 * and changing output must reset the run. It must also fail open (runs on every
 * tool call) and keep sessions independent (a shared serve runs many at once).
 */
import assert from "node:assert/strict";
import { LoopDetectorPlugin } from "../resources/opencode-plugins/loop-detector.js";

for (const k of ["LILY_LOOP_DETECT", "LILY_LOOP_NO_PROGRESS", "LILY_LOOP_PING_PONG"]) delete process.env[k];

const hooks = await LoopDetectorPlugin();
const after = hooks["tool.execute.after"];
assert.equal(typeof after, "function", "plugin registers tool.execute.after");

async function run(sessionID, tool, args, outText) {
  const output = { output: outText };
  await after({ sessionID, tool, args }, output);
  return output.output;
}
const looped = (s) => /\[loop\]/.test(s);

// 1) no-progress: same (tool,args,result) 3x -> nudge on the 3rd, not before.
assert.equal(looped(await run("s1", "read", { f: "a" }, "X")), false, "1st identical: no nudge");
assert.equal(looped(await run("s1", "read", { f: "a" }, "X")), false, "2nd identical: no nudge");
assert.equal(looped(await run("s1", "read", { f: "a" }, "X")), true, "3rd identical: nudged (no progress)");

// 2) RESULT-AWARE: same tool+args but CHANGING output is genuine progress -> never nudged.
for (const out of ["A", "B", "C", "D", "E"]) {
  assert.equal(looped(await run("s2", "build", { x: 1 }, out)), false, "changing output never triggers (zero false positive)");
}

// 3) ping-pong: A,B,A,B with no change -> nudged on the 4th. (no-progress raised out of the way.)
process.env.LILY_LOOP_NO_PROGRESS = "99";
const seq = [
  ["t", { x: 1 }, "A"],
  ["t", { x: 2 }, "B"],
  ["t", { x: 1 }, "A"],
  ["t", { x: 2 }, "B"],
];
let last3 = "";
for (const [t, a, o] of seq) last3 = await run("s3", t, a, o);
assert.equal(looped(last3), true, "A/B/A/B with no change -> ping-pong nudge");
delete process.env.LILY_LOOP_NO_PROGRESS;

// 4) env kill switch: detection fully off.
process.env.LILY_LOOP_DETECT = "0";
for (let i = 0; i < 4; i++) assert.equal(looped(await run("s4", "read", { f: "a" }, "X")), false, "LILY_LOOP_DETECT=0 disables");
delete process.env.LILY_LOOP_DETECT;

// 5) per-session isolation: the same signature in different sessions does NOT pool.
await run("s5", "read", { f: "a" }, "X");
await run("s5", "read", { f: "a" }, "X");
assert.equal(looped(await run("s6", "read", { f: "a" }, "X")), false, "another session's identical call does not count toward s5");

// 6) our own appended note must not pollute the signature -> still detected on the 4th.
assert.equal(looped(await run("s8", "grep", { q: "z" }, "same")), false, "");
assert.equal(looped(await run("s8", "grep", { q: "z" }, "same")), false, "");
assert.equal(looped(await run("s8", "grep", { q: "z" }, "same")), true, "3rd: nudged");
assert.equal(looped(await run("s8", "grep", { q: "z" }, "same")), true, "4th still detected (note did not pollute the signature)");

// 7) fail open: junk input/output never throws.
await after({}, {});
await after({ sessionID: "s9", tool: "x" }, null);
await after(null, null);
await after({ sessionID: "s9", tool: "x", args: { a: 1 } }, { content: [{ type: "text", text: "ok" }] });
console.log("loop-detector: ok");
