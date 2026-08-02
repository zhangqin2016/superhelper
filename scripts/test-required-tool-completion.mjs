import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createRequiredToolCompletionState,
  missingRequiredTools,
  noteRequiredToolDraft,
  normalizeRequiredTools,
} = require("../src/main/required-tool-completion.js");

assert.deepEqual(normalizeRequiredTools(["bash", "lily_character_draft", "lily_character_draft"]), [
  "lily_character_draft",
]);

const state = createRequiredToolCompletionState(["lily_character_draft"]);
assert.deepEqual(missingRequiredTools(state), ["lily_character_draft"]);

noteRequiredToolDraft(state, {
  type: "tool.started",
  payload: { id: "call-1", name: "lily_character_draft" },
});
noteRequiredToolDraft(state, {
  type: "tool.done",
  payload: { id: "call-1", isError: false, content: JSON.stringify({ ok: false, error: "INVALID_INPUT" }) },
});
assert.deepEqual(missingRequiredTools(state), ["lily_character_draft"], "failed domain results do not satisfy completion");

noteRequiredToolDraft(state, {
  type: "tool.started",
  payload: { id: "call-2", name: "lily_character_draft" },
});
noteRequiredToolDraft(state, {
  type: "tool.done",
  payload: { id: "call-2", isError: false, content: JSON.stringify({ ok: true, entityId: "character-1" }) },
});
assert.deepEqual(missingRequiredTools(state), []);

const errorState = createRequiredToolCompletionState(["lily_character_draft"]);
noteRequiredToolDraft(errorState, {
  type: "tool.started",
  payload: { id: "call-3", name: "lily_character_draft" },
});
noteRequiredToolDraft(errorState, {
  type: "tool.done",
  payload: { id: "call-3", isError: true, content: JSON.stringify({ ok: true }) },
});
assert.deepEqual(missingRequiredTools(errorState), ["lily_character_draft"]);

console.log("PASS: test-required-tool-completion");
