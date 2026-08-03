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
assert.deepEqual(
  missingRequiredTools(state),
  ["lily_character_draft"],
  "ok:true without revision evidence must not satisfy persistence",
);

noteRequiredToolDraft(state, {
  type: "tool.started",
  payload: { id: "call-4", name: "lily_character_draft" },
});
noteRequiredToolDraft(state, {
  type: "tool.done",
  payload: {
    id: "call-4",
    isError: false,
    content: JSON.stringify({ ok: true, entityId: "character-1", revisionId: "revision-1", revisionNumber: 1 }),
  },
});
assert.deepEqual(missingRequiredTools(state), []);

const prefixedState = createRequiredToolCompletionState(["lily_character_draft"]);
noteRequiredToolDraft(prefixedState, {
  type: "tool.started",
  payload: { id: "call-prefixed", name: "lily_tb_lily_character_draft" },
});
noteRequiredToolDraft(prefixedState, {
  type: "tool.done",
  payload: {
    id: "call-prefixed",
    isError: false,
    content: JSON.stringify({ ok: true, entityId: "character-2", revisionId: "revision-2", revisionNumber: 1 }),
  },
});
assert.deepEqual(
  missingRequiredTools(prefixedState),
  [],
  "OpenCode MCP server prefixes must still satisfy the canonical Lily persistence requirement",
);

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
