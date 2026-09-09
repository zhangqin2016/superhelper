#!/usr/bin/env node
/**
 * The skill-count cap must fail LEGIBLY, not with a misleading field name.
 *
 * Before: activeSkillIds > 64 threw "RUNTIME_IDENTITY_FIELD_INVALID:
 * capabilities are invalid" — wrong field, no action. The token shares one
 * validator for both fields; this checks each names itself and that over-limit
 * is a distinct, actionable condition surfaced to the user in words.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ri = require("../src/main/runtime-identity.js");
const { sanitizeError } = require("../src/main/agent-runner.js");

const secret = "s".repeat(48);
const base = {
  audience: "tool-broker", principalId: "session:x", workspaceId: "w", projectId: "p",
  sessionId: "s", turnId: "t", attemptId: "a", workspacePath: "/tmp", permissionMode: "ask",
};
const issue = (over) => ri.issueRuntimeIdentity({ ...base, ...over }, { secret });

// 65 active skills — the reported case. The error must name activeSkillIds and be a distinct code.
let err;
try { issue({ activeSkillIds: Array.from({ length: 65 }, (_, i) => `skill-${i}`) }); }
catch (e) { err = e; }
assert.ok(err, "65 active skills must be rejected");
assert.equal(err.code, "RUNTIME_IDENTITY_TOO_MANY_SKILLS", "over-limit is its own code, not FIELD_INVALID");
assert.match(err.message, /activeSkillIds/, "the message names the field that actually overflowed");
assert.match(err.message, /65/, "and reports the actual count");
assert.doesNotMatch(err.message, /capabilities are invalid/, "no longer the misleading capabilities message");

// The capabilities field, when IT overflows, names itself.
let capErr;
try { issue({ activeSkillIds: [], capabilities: Array.from({ length: 65 }, (_, i) => `cap-${i}`) }); }
catch (e) { capErr = e; }
assert.match(capErr.message, /capabilities exceeds the 64-item limit/, "capabilities overflow names capabilities");
  assert.equal(capErr.code, "RUNTIME_IDENTITY_TOO_MANY_SKILLS");

// Exactly 64 is fine (boundary).
const ok = issue({ activeSkillIds: Array.from({ length: 64 }, (_, i) => `skill-${i}`) });
assert.ok(ok && typeof ok === "string", "64 active skills issue a token");

// A genuinely malformed (non-array) field is still FIELD_INVALID, named.
let badErr;
try { issue({ activeSkillIds: "not-an-array" }); } catch (e) { badErr = e; }
assert.equal(badErr.code, "RUNTIME_IDENTITY_FIELD_INVALID");
assert.match(badErr.message, /activeSkillIds is invalid/);

// The user sees an actionable message, not a raw code.
const shown = sanitizeError(`RUNTIME_IDENTITY_TOO_MANY_SKILLS: activeSkillIds exceeds the 64-item limit (65)`);
assert.match(shown, /技能过多|停用/, "the user is told what to do, not shown a raw code");
assert.doesNotMatch(shown, /RUNTIME_IDENTITY|activeSkillIds/, "the raw code is not surfaced");
// The legacy string also maps (older tokens / cached errors).
assert.match(sanitizeError("RUNTIME_IDENTITY_FIELD_INVALID: capabilities are invalid"), /技能过多|停用/);

console.log("runtime identity skill cap: ok");
