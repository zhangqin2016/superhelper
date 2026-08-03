"use strict";

const crypto = require("node:crypto");
const { getLogger } = require("./logger");
const log = getLogger("public-hooks");
const EVENTS = new Set([
  "session.start", "session.end",
  "turn.admitted", "turn.before_dispatch", "turn.completed", "turn.failed",
  "tool.before", "tool.after", "tool.failed",
  "agent.spawned", "agent.started", "agent.waiting", "agent.completed",
  "checkpoint.before", "checkpoint.after", "checkpoint.restore",
  "compaction.before", "compaction.after",
  "worktree.create", "worktree.remove",
]);
const TYPES = new Set(["command", "http", "prompt", "agent", "mcp"]);
const SECRET_KEY = /(token|secret|password|authorization|api[-_]?key|cookie)/i;

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function bounded(value, name, max = 256) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw codedError("PUBLIC_HOOK_FIELD_INVALID", name);
  }
  return text;
}

function redactHookValue(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactHookValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 4_000 ? `${value.slice(0, 4_000)}...[TRUNCATED]` : value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactHookValue(item, depth + 1);
  }
  return out;
}

function normalizeHook(input = {}) {
  const event = bounded(input.event, "event", 80);
  const type = bounded(input.type, "type", 40);
  if (!EVENTS.has(event)) throw codedError("PUBLIC_HOOK_EVENT_INVALID", event);
  if (!TYPES.has(type)) throw codedError("PUBLIC_HOOK_TYPE_INVALID", type);
  const mode = input.mode === "security" ? "security" : "observe";
  const authority = input.authority === "security" || mode === "security" ? "security" : "observe";
  const failurePolicy = input.failurePolicy || (authority === "security" ? "closed" : "open");
  if (!new Set(["open", "closed"]).has(failurePolicy) || (authority === "security" && failurePolicy !== "closed")) {
    throw codedError("PUBLIC_HOOK_FAILURE_POLICY_INVALID");
  }
  const inputFields = Array.isArray(input.inputSchema?.fields)
    ? [...new Set(input.inputSchema.fields.map((field) => bounded(field, "inputSchema.fields", 120)))].slice(0, 64)
    : [];
  const timeoutMs = Math.floor(Number(input.timeoutMs ?? 10_000));
  if (timeoutMs < 1 || timeoutMs > 300_000) throw codedError("PUBLIC_HOOK_TIMEOUT_INVALID");
  return Object.freeze({
    id: bounded(input.id, "id"),
    event,
    type,
    mode,
    authority,
    failurePolicy,
    inputSchema: Object.freeze({ fields: Object.freeze(inputFields) }),
    canMutate: input.canMutate === true,
    timeoutMs,
    config: redactHookValue(input.config || {}),
  });
}

function normalizeDecision(output, hook) {
  if (!output || typeof output !== "object") {
    return { allow: true, reason: "", contextAppend: "" };
  }
  const reason = String(output.reason || "").slice(0, 1_000);
  if (!hook.canMutate) return { allow: true, reason, contextAppend: "" };
  const contextAppend = String(output.contextAppend || "").slice(0, 4_000);
  return {
    allow: output.allow !== false,
    reason,
    contextAppend,
  };
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(codedError("PUBLIC_HOOK_TIMEOUT")), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function createPublicHookRuntime({ executors = {}, emitAudit = () => {}, now = () => Date.now() } = {}) {
  const hooks = new Map();

  function audit(event) {
    try { emitAudit(redactHookValue({ schemaVersion: 1, ts: now(), ...event })); } catch { /* audit cannot break execution */ }
  }

  function register(input) {
    const hook = normalizeHook(input);
    if (hooks.has(hook.id)) throw codedError("PUBLIC_HOOK_DUPLICATE", hook.id);
    if (typeof executors[hook.type] !== "function") throw codedError("PUBLIC_HOOK_EXECUTOR_UNAVAILABLE", hook.type);
    hooks.set(hook.id, hook);
    return hook;
  }

  function unregister(id) {
    return hooks.delete(String(id || ""));
  }

  async function run(eventType, payload = {}, options = {}) {
    if (!EVENTS.has(eventType)) throw codedError("PUBLIC_HOOK_EVENT_INVALID", eventType);
    const chain = Array.isArray(options.chain) ? options.chain.map(String) : [];
    const selected = [...hooks.values()].filter((hook) => hook.event === eventType);
    const outcome = { allow: true, reason: "", contextAppend: "", results: [], failures: [] };
    const redactedPayload = redactHookValue(payload);
    const scope = { sessionId: String(payload.sessionId || ""), turnId: String(payload.turnId || "") };

    for (const hook of selected) {
      const executionId = `hook_exec_${crypto.randomUUID()}`;
      if (chain.includes(hook.id)) {
        audit({ type: "hook.rejected", executionId, hookId: hook.id, eventType, code: "PUBLIC_HOOK_RECURSION", ...scope });
        throw codedError("PUBLIC_HOOK_RECURSION", hook.id);
      }
      const startedAt = now();
      audit({ type: "hook.started", executionId, hookId: hook.id, eventType, mode: hook.mode, ...scope });
      try {
        const selectedPayload = hook.inputSchema.fields.length
          ? Object.fromEntries(hook.inputSchema.fields.filter((key) => Object.hasOwn(redactedPayload, key)).map((key) => [key, redactedPayload[key]]))
          : redactedPayload;
        const raw = await withTimeout(executors[hook.type](hook, {
          schemaVersion: 1,
          type: eventType,
          payload: selectedPayload,
          ts: now(),
          chain: [...chain, hook.id],
        }), hook.timeoutMs);
        const decision = normalizeDecision(raw, hook);
        const result = { hookId: hook.id, allow: decision.allow, reason: decision.reason, durationMs: Math.max(0, now() - startedAt) };
        outcome.results.push(result);
        if (decision.contextAppend) outcome.contextAppend = [outcome.contextAppend, decision.contextAppend].filter(Boolean).join("\n").slice(0, 4_000);
        if (hook.authority === "security" && !decision.allow) {
          outcome.allow = false;
          outcome.reason = decision.reason || `Denied by ${hook.id}`;
        }
        audit({ type: "hook.completed", executionId, eventType, mode: hook.mode, ...scope, ...result });
      } catch (error) {
        const code = error?.code || "PUBLIC_HOOK_EXECUTION_FAILED";
        const failure = { hookId: hook.id, code, message: String(error?.message || error).slice(0, 1_000), mode: hook.mode };
        outcome.failures.push(failure);
        if (hook.failurePolicy === "closed") {
          outcome.allow = false;
          outcome.reason = `Security hook ${hook.id} failed: ${code}`;
        }
        audit({ type: "hook.failed", executionId, eventType, ...scope, ...failure });
      }
    }
    return outcome;
  }

  function list(eventType = "") {
    return [...hooks.values()].filter((hook) => !eventType || hook.event === eventType);
  }

  return Object.freeze({ register, unregister, run, list });
}

function observePublicTerminalHook(ctx, terminalType, sessionId, turnId, state, assistant) {
  if (!ctx.publicHookRuntime || process.env.LILY_PUBLIC_HOOKS_V1 === "0") return;
  const event = terminalType === "turn.completed" ? "turn.completed" : "turn.failed";
  void ctx.publicHookRuntime.run(event, {
    sessionId,
    turnId,
    taskRunId: state.taskRun?.id || "",
    terminalType,
    assistant,
  }).catch((err) => log.warn("public terminal hook failed open: %s", err?.message || err));
}

function observePublicHook(runtime, event, payload) {
  if (!runtime || process.env.LILY_PUBLIC_HOOKS_V1 === "0") return;
  void runtime.run(event, payload).catch((err) => log.warn("public %s hook failed open: %s", event, err?.message || err));
}

module.exports = { EVENTS, createPublicHookRuntime, observePublicHook, observePublicTerminalHook, redactHookValue };
