#!/usr/bin/env node
/**
 * A leaked tool call must not kill a turn that already did work.
 *
 * The rescue for MALFORMED_TOOL_CALL_TEXT replays the user's request with a
 * corrective hint, which is only safe when every tool that ran was replay-safe.
 * So the reported case got no rescue at all: 148 tool calls in, files already
 * edited, the model wrote its next call as text, and the user saw the raw
 * failure. Replaying would have re-run the edits, so refusing was right — but
 * failing was not the only alternative.
 *
 * Continuing the same engine session re-does nothing: history and files are
 * still there, and only the missing next action is requested. Strictly
 * additive, because these turns previously received no rescue whatsoever.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rescue = require("../src/main/tool-call-rescue.js");

const READ_ONLY = [{ name: "read" }, { name: "grep" }];
const WROTE_FILES = [{ name: "read" }, { name: "edit" }];

// --- when continuation applies -------------------------------------------

assert.equal(
  rescue.shouldContinueInsteadOfReplay("MALFORMED_TOOL_CALL_TEXT", WROTE_FILES),
  true,
  "a leaked tool call after a file edit is exactly the case replay cannot serve",
);
assert.equal(
  rescue.shouldContinueInsteadOfReplay("MALFORMED_TOOL_CALL_TEXT", READ_ONLY),
  false,
  "a read-only turn must keep using replay — it reproduces the turn cleanly",
);
assert.equal(
  rescue.shouldContinueInsteadOfReplay("MALFORMED_TOOL_CALL_TEXT", []),
  false,
  "a turn that ran no tools is trivially replay-safe",
);
for (const code of ["EMPTY_ASSISTANT_COMPLETION", "RESPONSE_ERROR", "TRUNCATED_TURN_END", "", null]) {
  assert.equal(
    rescue.shouldContinueInsteadOfReplay(code, WROTE_FILES),
    false,
    `${JSON.stringify(code)} must not be continued — continuation is specific to a leaked tool call, whose next step is the only thing missing`,
  );
}

// --- kill switch ---------------------------------------------------------

process.env.LILY_TOOL_CALL_CONTINUATION = "0";
assert.equal(
  rescue.shouldContinueInsteadOfReplay("MALFORMED_TOOL_CALL_TEXT", WROTE_FILES),
  false,
  "the kill switch must restore the previous behaviour, where such a turn simply failed",
);
delete process.env.LILY_TOOL_CALL_CONTINUATION;
assert.equal(rescue.shouldContinueInsteadOfReplay("MALFORMED_TOOL_CALL_TEXT", WROTE_FILES), true, "and come back when unset");

// --- what the continuation actually says ---------------------------------

for (const [language, hint] of [["en", rescue.continuationHintFor({})], ["zh", rescue.continuationHintFor({ instructionLanguage: "zh" })]]) {
  assert.ok(hint.trim(), `${language}: a continuation needs text`);
  assert.notEqual(
    hint,
    rescue.correctiveHintFor({ instructionLanguage: language === "zh" ? "zh" : "en" }),
    `${language}: continuation must not reuse the replay hint — replay says "retry", continuation must say "do not redo"`,
  );
}
// The load-bearing instruction: do not redo completed work. Without it a
// continuation risks double-applying the edits the guard was protecting.
assert.match(rescue.continuationHintFor({}), /do NOT redo|already completed|still written/i, "en continuation must forbid redoing completed work");
assert.match(rescue.continuationHintFor({ instructionLanguage: "zh" }), /不要重做|已经完成|仍然存在/, "zh continuation must forbid redoing completed work");
// And it must still teach the native-call rule, which is why the turn failed.
assert.match(rescue.continuationHintFor({}), /NATIVE structured tool/i, "en continuation must still correct the format");
assert.match(rescue.continuationHintFor({ instructionLanguage: "zh" }), /原生的结构化调用/, "zh continuation must still correct the format");
// A continuation that reads as a restart would defeat the purpose.
assert.match(rescue.continuationHintFor({}), /CONTINUATION of the same task, not a restart/i, "en continuation must frame itself as a continuation");
assert.match(rescue.continuationHintFor({ instructionLanguage: "zh" }), /不是重新开始/, "zh continuation must frame itself as a continuation");

// --- wired so the guard no longer drops the turn -------------------------

const runtime = fs.readFileSync(path.join(ROOT, "src/main/turn-recovery-runtime.js"), "utf8");
assert.match(runtime, /shouldContinueInsteadOfReplay\(failure\?\.code, ranTools\)/, "the decision must use the real failure code and the tools that actually ran");
assert.match(
  runtime,
  /!documentRecovery && !continueInstead && !rescue\.isSideEffectFreeToolRun\(ranTools\)\) return false;/,
  "the side-effect guard must still refuse a REPLAY; continuation is the only thing allowed past it",
);
// Pin this to the CONTENT site specifically. Matching "continueInstead ?
// continuationHintFor" anywhere also matched the separate `hint` assignment, so
// swapping the content back to the user's message passed the gate.
assert.match(
  runtime,
  /const content = documentRecovery[\s\S]{0,160}continueInstead[\s\S]{0,80}rescue\.continuationHintFor/,
  "the SENT CONTENT of a continuation must be the continuation text, not the user's original message",
);
assert.match(runtime, /documentRecovery \|\| continueInstead \? \[\] : \(lastUser\.files/, "a continuation must not resend the user's attachments");
assert.match(runtime, /mode: continueInstead \? "continuation" : "replay"/, "the recovery record must say which mode ran, or the logs cannot tell them apart");

// The predicate must be consulted BEFORE the guard can return false, otherwise
// the continuation is unreachable — the defect this whole change fixes.
const guardIndex = runtime.indexOf("!rescue.isSideEffectFreeToolRun(ranTools)) return false;");
const decideIndex = runtime.indexOf("shouldContinueInsteadOfReplay(failure?.code, ranTools)");
assert.ok(decideIndex > 0 && guardIndex > 0, "both the decision and the guard must be present");
assert.ok(decideIndex < guardIndex, "the continuation decision must come before the guard, or it can never be reached");

console.log("tool call continuation: ok");
console.log(`  replay kept for read-only turns; continuation added for turns that already wrote`);
console.log(`  en ${Buffer.byteLength(rescue.continuationHintFor({}), "utf8")}B / zh ${Buffer.byteLength(rescue.continuationHintFor({ instructionLanguage: "zh" }), "utf8")}B`);
