"use strict";

const DANGEROUS_SHELL_RE = /(^|\s)(rm\s+-[^\n;|&]*[rf]|git\s+(?:commit|push|tag|reset|checkout|clean)|npm\s+publish|pnpm\s+publish|yarn\s+publish|curl\b[^\n;|&]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE))|kubectl\s+(?:delete|apply|replace|patch)|docker\s+(?:push|rm|rmi)|mv\s+|cp\s+)/i;

const registry = new Map();

function normalizedName(value = "") {
  return String(value || "").trim().toLowerCase();
}

function registerToolSemantics(name, semantics = {}) {
  const key = normalizedName(name);
  if (!key) return null;
  const readOnly = semantics.readOnly === true;
  const destructive = semantics.destructive === true;
  const idempotent = semantics.idempotent === true || readOnly;
  const entry = Object.freeze({
    name: key,
    readOnly,
    destructive,
    idempotent,
    externalSideEffect: semantics.externalSideEffect === true || (!readOnly && semantics.externalSideEffect !== false),
    replaySafe: semantics.replaySafe === true || (readOnly && idempotent && !destructive),
    evidenceKind: String(semantics.evidenceKind || "tool_observation"),
  });
  registry.set(key, entry);
  return entry;
}

function semanticsFromAnnotations(annotations = {}) {
  if (!annotations || typeof annotations !== "object") return null;
  const declared = annotations.readOnlyHint === true || annotations.destructiveHint === true;
  if (!declared) return null;
  return {
    readOnly: annotations.readOnlyHint === true,
    destructive: annotations.destructiveHint === true,
    idempotent: annotations.idempotentHint === true || annotations.readOnlyHint === true,
    externalSideEffect: annotations.openWorldHint === true && annotations.readOnlyHint !== true,
  };
}

function registerToolDefinitions(definitions = []) {
  for (const tool of Array.isArray(definitions) ? definitions : []) {
    const annotated = semanticsFromAnnotations(tool?.annotations);
    if (!tool?.name || !annotated) continue;
    registerToolSemantics(tool.name, annotated);
  }
}

function registeredSemantics(name = "") {
  const raw = normalizedName(name);
  if (!raw) return null;
  if (registry.has(raw)) return registry.get(raw);
  const candidate = [...registry.keys()]
    .sort((a, b) => b.length - a.length)
    .find((key) => (
      raw.endsWith(`.${key}`) ||
      raw.endsWith(`/${key}`) ||
      raw.endsWith(`:${key}`) ||
      raw.endsWith(`_${key}`)
    ));
  return candidate ? registry.get(candidate) : null;
}

function resolveToolSemantics(toolOrName = {}) {
  const tool = typeof toolOrName === "string" ? { name: toolOrName } : toolOrName || {};
  const name = normalizedName(tool.name || tool.tool);
  if (name === "bash" || name.endsWith(".bash") || name.endsWith("_bash")) {
    const command = String(tool.input?.command || tool.input?.cmd || "");
    return {
      name,
      readOnly: false,
      destructive: DANGEROUS_SHELL_RE.test(command),
      idempotent: false,
      externalSideEffect: true,
      replaySafe: false,
      evidenceKind: "command",
    };
  }
  const annotations = semanticsFromAnnotations(tool.annotations || tool.metadata?.annotations);
  if (annotations) return registerToolSemantics(name, annotations);
  const registered = registeredSemantics(name);
  if (registered) return registered;
  return {
    name: name || "unknown",
    readOnly: false,
    destructive: false,
    idempotent: false,
    externalSideEffect: true,
    replaySafe: false,
    evidenceKind: "tool_observation",
  };
}

function isReplaySafeTool(tool) {
  return resolveToolSemantics(tool).replaySafe === true;
}

function isSideEffectFreeToolRun(tools = []) {
  return (Array.isArray(tools) ? tools : []).every(isReplaySafeTool);
}

[
  ["read", { readOnly: true, evidenceKind: "file_read" }],
  ["notebookread", { readOnly: true, evidenceKind: "file_read" }],
  ["glob", { readOnly: true, evidenceKind: "file_search" }],
  ["grep", { readOnly: true, evidenceKind: "file_search" }],
  ["list", { readOnly: true, evidenceKind: "file_search" }],
  ["ls", { readOnly: true, evidenceKind: "file_search" }],
  ["find", { readOnly: true, evidenceKind: "file_search" }],
  ["search", { readOnly: true, evidenceKind: "file_search" }],
  ["lsp", { readOnly: true, evidenceKind: "file_read" }],
  ["webfetch", { readOnly: true, evidenceKind: "web_fetch" }],
  ["websearch", { readOnly: true, evidenceKind: "web_search" }],
  ["todoread", { readOnly: true }],
  ["todowrite", { idempotent: true, replaySafe: true, externalSideEffect: false }],
  ["question", { idempotent: true, replaySafe: true, externalSideEffect: false }],
  ["lily_intent_contract_commit", { readOnly: true, evidenceKind: "intent_contract" }],
  ["edit", { destructive: true }],
  ["multiedit", { destructive: true }],
  ["write", { destructive: true }],
  ["delete", { destructive: true }],
  ["rm", { destructive: true }],
  ["mv", { destructive: true }],
  ["cp", { destructive: true }],
  ["git", { destructive: true }],
  ["apply_patch", { destructive: true }],
  ["notebookedit", { destructive: true }],
].forEach(([name, semantics]) => registerToolSemantics(name, semantics));

module.exports = {
  DANGEROUS_SHELL_RE,
  isReplaySafeTool,
  isSideEffectFreeToolRun,
  registerToolDefinitions,
  registerToolSemantics,
  resolveToolSemantics,
};
