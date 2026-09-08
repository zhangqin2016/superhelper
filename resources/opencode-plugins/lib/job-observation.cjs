"use strict";

// Shared by the Bun plugin and Electron host. Never mutate the wire receipt.
const JOB_READ = /^(?:(?:mcp(?:__|[._:/]))?lily_(?:process_jobs|pj)(?:__|[._:/]))?job_(?:status|logs)$/;
const STATES = new Set(["queued", "starting", "running", "succeeded", "failed", "cancelled", "stopped", "exited", "outcome_unknown"]);
const LOOP_NOTE = "\n\n[loop] 检测到无进展的重复";

function canonical(value, depth = 0) {
  if (depth > 16) throw new Error("observation too deep");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  return value;
}

function jobObservation(name, input, result) {
  if (!JOB_READ.test(String(name || "").toLowerCase()) || !input?.jobId) return null;
  try {
    if (typeof result === "string") {
      if (result.length > 1_000_000) return null;
      return jobObservation(name, input, JSON.parse(result.split(LOOP_NOTE)[0]));
    }
    if (result?.isError === true) return null;
    if (Array.isArray(result?.content) && result.content.length === 1 && result.content[0]?.type === "text") return jobObservation(name, input, result.content[0].text);
    if (result?.ok !== true || result.jobId !== input.jobId || !STATES.has(result.state || result.status)) return null;
    if (result.state && result.status && result.state !== result.status) return null;
    const stable = { ...result };
    for (const key of ["updatedAt", "heartbeatAt", "lastObservedAt", "observedAt"]) delete stable[key];
    return canonical(stable);
  } catch { return null; }
}

function stableToolResult(name, input, result) {
  if (!JOB_READ.test(String(name || "").toLowerCase()) || !input?.jobId) return result;
  if (result?.isError === true) return result;
  try {
    if (typeof result === "string") {
      if (result.length > 1_000_000) return result;
      const raw = result.includes(LOOP_NOTE) ? result.slice(0, result.indexOf(LOOP_NOTE)) : result;
      const parsed = JSON.parse(raw);
      const stable = stableToolResult(name, input, parsed);
      return stable === parsed ? result : JSON.stringify(stable);
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    if (Array.isArray(result.content) && result.content.length === 1) {
      return { ...result, content: result.content.map(part => part?.type === "text"
        ? { ...part, text: stableToolResult(name, input, part.text) } : part) };
    }
    return jobObservation(name, input, result) || result;
  } catch { return result; } // Unknown/malformed/oversized data keeps the baseline.
}

module.exports = { stableToolResult, jobObservation };
