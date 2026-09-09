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
const MAX = ri.MAX_CAPABILITIES;
const { sanitizeError } = require("../src/main/agent-runner.js");

const secret = "s".repeat(48);
const base = {
  audience: "tool-broker", principalId: "session:x", workspaceId: "w", projectId: "p",
  sessionId: "s", turnId: "t", attemptId: "a", workspacePath: "/tmp", permissionMode: "ask",
};
const issue = (over) => ri.issueRuntimeIdentity({ ...base, ...over }, { secret });

// 65 active skills — the reported case. The error must name activeSkillIds and be a distinct code.
let err;
try { issue({ activeSkillIds: Array.from({ length: MAX + 1 }, (_, i) => `skill-${i}`) }); }
catch (e) { err = e; }
assert.ok(err, "over-limit active skills must be rejected");
assert.equal(err.code, "RUNTIME_IDENTITY_TOO_MANY_SKILLS", "over-limit is its own code, not FIELD_INVALID");
assert.match(err.message, /activeSkillIds/, "the message names the field that actually overflowed");
assert.match(err.message, new RegExp(String(MAX + 1)), "and reports the actual count");
assert.doesNotMatch(err.message, /capabilities are invalid/, "no longer the misleading capabilities message");

// The capabilities field, when IT overflows, names itself.
let capErr;
try { issue({ activeSkillIds: [], capabilities: Array.from({ length: MAX + 1 }, (_, i) => `cap-${i}`) }); }
catch (e) { capErr = e; }
assert.match(capErr.message, new RegExp(`capabilities exceeds the ${MAX}-item limit`), "capabilities overflow names capabilities");
  assert.equal(capErr.code, "RUNTIME_IDENTITY_TOO_MANY_SKILLS");

// Exactly 64 is fine (boundary).
const ok = issue({ activeSkillIds: Array.from({ length: MAX }, (_, i) => `skill-${i}`) });
assert.ok(ok && typeof ok === "string", `${MAX} active skills issue a token`);

// A genuinely malformed (non-array) field is still FIELD_INVALID, named.
let badErr;
try { issue({ activeSkillIds: "not-an-array" }); } catch (e) { badErr = e; }
assert.equal(badErr.code, "RUNTIME_IDENTITY_FIELD_INVALID");
assert.match(badErr.message, /activeSkillIds is invalid/);

// The user sees an actionable message, not a raw code.
const shown = sanitizeError(`RUNTIME_IDENTITY_TOO_MANY_SKILLS: activeSkillIds exceeds the ${MAX}-item limit (${MAX + 1})`);
assert.match(shown, /技能过多|停用/, "the user is told what to do, not shown a raw code");
assert.doesNotMatch(shown, /RUNTIME_IDENTITY|activeSkillIds/, "the raw code is not surfaced");
// The legacy string also maps (older tokens / cached errors).
assert.match(sanitizeError("RUNTIME_IDENTITY_FIELD_INVALID: capabilities are invalid"), /技能过多|停用/);

assert.ok(issue({ activeSkillIds: Array.from({ length: 94 }, (_, i) => `learned-skill-${i}`) }), "a rich workspace (94 enabled) now issues a token instead of failing");
assert.ok(MAX >= 128, "the authorization scope comfortably holds a rich workspace");
console.log("runtime identity skill cap: ok");
