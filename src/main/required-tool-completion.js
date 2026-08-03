"use strict";

function normalizeRequiredTools(requiredTools = []) {
  return Array.isArray(requiredTools)
    ? [...new Set(requiredTools.filter((name) => name === "lily_character_draft"))].slice(0, 1)
    : [];
}

// OpenCode exposes MCP tools with the server key prefixed to the tool name
// (for example `lily_tb_lily_character_draft`). Completion requirements use
// Lily's canonical name so a transport detail cannot turn a real write into a
// false persistence failure.
function canonicalToolName(name) {
  const value = String(name || "").trim();
  for (const prefix of ["lily_tb_", "lily_tool_broker_", "lily_tb.", "lily_tool_broker."]) {
    if (value.startsWith(prefix) && value.slice(prefix.length) === "lily_character_draft") {
      return "lily_character_draft";
    }
  }
  return value;
}

function createRequiredToolCompletionState(requiredTools = []) {
  const required = new Set(normalizeRequiredTools(requiredTools));
  return { required, successful: new Set(), successfulResults: new Map(), activeById: new Map() };
}

function parseResult(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 1024 * 1024) return null;
    try { return parseResult(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseResult(item, depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (value.ok === true) return value;
  if (value.result) {
    const parsed = parseResult(value.result, depth + 1);
    if (parsed) return parsed;
  }
  if (value.text) return parseResult(value.text, depth + 1);
  if (value.content) return parseResult(value.content, depth + 1);
  return null;
}

function validPersistenceResult(result) {
  return result?.ok === true
    && typeof result.entityId === "string" && result.entityId.trim().length > 0
    && typeof result.revisionId === "string" && result.revisionId.trim().length > 0
    && Number.isSafeInteger(result.revisionNumber) && result.revisionNumber > 0;
}

function noteRequiredToolDraft(state, draft = {}) {
  if (!state?.required?.size) return;
  const payload = draft.payload || {};
  const id = String(payload.id || "");
  if (draft.type === "tool.started") {
    const name = canonicalToolName(payload.name);
    if (id && state.required.has(name)) {
      const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
        ? {
            action: String(payload.input.action || ""),
            kind: String(payload.input.kind || ""),
            entityId: String(payload.input.entityId || ""),
            expectedBaseRevisionId: String(payload.input.expectedBaseRevisionId || ""),
          }
        : {};
      state.activeById.set(id, { name, input });
    }
    return;
  }
  if (draft.type !== "tool.done") return;
  const active = state.activeById.get(id);
  const name = active?.name || canonicalToolName(payload.name);
  if (id) state.activeById.delete(id);
  const result = payload.isError !== true ? parseResult(payload.content) : null;
  if (state.required.has(name) && validPersistenceResult(result)) {
    state.successful.add(name);
    const evidence = {
      name,
      callId: id,
      input: active?.input || {},
      result: {
        ok: true,
        entityId: String(result.entityId || ""),
        revisionId: String(result.revisionId || ""),
        revisionNumber: Number.isSafeInteger(result.revisionNumber) ? result.revisionNumber : 0,
      },
    };
    if (Buffer.byteLength(JSON.stringify(evidence), "utf8") <= 8192) {
      state.successfulResults.set(id || name, Object.freeze(evidence));
    }
  }
}

function successfulRequiredToolResults(state) {
  return state?.successfulResults instanceof Map
    ? [...state.successfulResults.values()]
    : [];
}

function missingRequiredTools(state) {
  if (!state?.required) return [];
  return [...state.required].filter((name) => !state.successful.has(name));
}

module.exports = {
  createRequiredToolCompletionState,
  missingRequiredTools,
  noteRequiredToolDraft,
  normalizeRequiredTools,
  successfulRequiredToolResults,
};
