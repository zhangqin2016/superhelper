"use strict";

const { classifyAssistantError } = require("./agent-runner");
const { isTransientNetworkCode } = require("../shared/network-errors.mjs");

// Read only error-envelope fields, never request bodies, headers or tool output.
// Native Error properties are not enumerable; JSON serialization loses them.
function errorFacts(message, cause) {
  const queue = [message, cause], seen = new Set();
  const texts = [], codes = [], statuses = [], names = [], retryFlags = [];
  for (let index = 0; index < queue.length && index < 24; index++) {
    const value = queue[index];
    if (typeof value === "string") { texts.push(value.slice(0, 16000)); continue; }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (typeof value.message === "string") texts.push(value.message.slice(0, 16000));
    if (typeof value.code === "string") codes.push(value.code);
    if (typeof value.name === "string") names.push(value.name);
    for (const key of ["statusCode", "status"]) {
      if (Number.isInteger(value[key]) && value[key] >= 400 && value[key] <= 599) statuses.push(value[key]);
    }
    for (const key of ["retryable", "isRetryable"]) {
      if (typeof value[key] === "boolean") retryFlags.push(value[key]);
    }
    for (const key of ["cause", "error", "data", "details"]) if (value[key]) queue.push(value[key]);
  }
  return { texts, codes, statuses, names, retryFlags };
}

function normalizeRunnerFailure(message, cause = null) {
  const facts = errorFacts(message, cause);
  const raw = facts.texts.join("\n");
  const matches = facts.texts.map(classifyAssistantError).filter(Boolean);
  const engineExit = facts.names.includes("EngineExitError") && facts.codes.includes("ENGINE_UNAVAILABLE");
  // A nested auth/quota/context rejection overrides a transient outer wrapper.
  let classified = matches.find(item => item.retryable === false)
    || (engineExit ? classifyAssistantError("The assistant engine became unreachable") : null)
    || matches.find(item => item.code !== "MODEL_CONNECTION_FAILED") || matches[0] || null;
  const permanentStatus = facts.statuses.find(status => status < 500 && ![408, 429].includes(status));
  if (!classified || classified.code === "MODEL_CONNECTION_FAILED") {
    if (permanentStatus) {
      classified = { code: "ENGINE_ERROR", category: "model", retryable: false, message: `The model service rejected this request (HTTP ${permanentStatus}). Automatic retry is unavailable.` };
    } else if (facts.statuses.includes(429)) {
      classified = classifyAssistantError("HTTP 429 too many requests");
    } else if (facts.codes.some(isTransientNetworkCode)
      || facts.statuses.some(status => status === 408 || status >= 500)
      || (facts.retryFlags.includes(true) && facts.names.some(name => /^(?:AI_APICallError|APIError)$/.test(name)))) {
      classified = classifyAssistantError("Connection to the model service was interrupted");
    }
  }
  if (facts.retryFlags.includes(false)) {
    const message = classified?.retryable === false ? classified.message
      : "The model service reported a non-retryable failure. Automatic retry has stopped.";
    classified = { ...(classified || { code: "ENGINE_ERROR", category: "runtime" }), message, retryable: false };
  }
  return { raw, classified };
}

module.exports = { normalizeRunnerFailure };
