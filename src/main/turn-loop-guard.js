"use strict";

const { createHash } = require("node:crypto");
const { jobObservation } = require("../../resources/opencode-plugins/lib/job-observation.cjs");
const states = new WeakMap();
const MAX_TEXT = 32_768;
const MIN_REPEATED_CHARS = 240;
const REPEATS = 6;
const POLL_REPEATS = 12;

function digest(value) {
  const canonical = (item, depth = 0) => {
    if (depth > 16) throw new Error("observation too deep");
    if (Array.isArray(item)) return item.map(v => canonical(v, depth + 1));
    return item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key], depth + 1)])) : item;
  };
  const text = JSON.stringify(canonical(value));
  if (text.length > 1_000_000) throw new Error("observation too large");
  return createHash("sha256").update(text).digest("hex");
}

function repeatedText(text, requested = "") {
  // Fail open for code, quotations and structured repeated data. No phrase blacklist.
  if (/```|~~~|(?:^|\n)\s*(?:>|["“]|[-*]\s|\d+[.)]\s)/u.test(text)) return false;
  const units = text.split(/[.!?。！？\n]+/u).slice(0, -1).map(s => s.trim()).filter(Boolean).slice(-48);
  for (let width = 1; width <= 4; width++) {
    const pattern = units.slice(-width);
    if (pattern.length !== width || pattern.some(unit => unit.length < 6 || unit.length > 512 || !/\p{L}/u.test(unit) || requested.includes(unit))) continue;
    const span = width * Math.max(REPEATS, Math.ceil(MIN_REPEATED_CHARS / pattern.join("").length));
    if (units.length < span) continue;
    const tail = units.slice(-span);
    if (tail.join("").length >= MIN_REPEATED_CHARS && tail.every((unit, i) => unit === pattern[i % width])) return span / width;
  }
  return false;
}

/** An observer, not a tool runner. Only confirmed repetition can request a stop. */
function observeTurnLoop(session, reduced) {
  const baseline = { progress: reduced.progress, stop: false };
  if (process.env.LILY_TURN_LOOP_GUARD === "0" || !session._turnGates) return baseline;
  try {
    let state = states.get(session._turnGates);
    if (!state) { state = { text: "", protectedText: false, tools: new Map(), jobs: new Map() }; states.set(session._turnGates, state); }
    if (session._pendingPermissions.size || session._pendingQuestions.size) { state.text = ""; state.jobs.clear(); return baseline; }
    for (const draft of reduced.drafts || []) {
      const p = draft.payload || {};
      if (draft.type === "tool.started") {
        if (state.tools.size < 256) state.tools.set(p.id, { name: p.name, input: p.input });
      } else if (draft.type === "tool.done") {
        const tool = state.tools.get(p.id); state.tools.delete(p.id);
        if (!tool) continue;
        if ([...session._activeTools.keys()].some(id => id !== p.id)) { state.text = ""; state.jobs.clear(); continue; }
        const raw = p.content ?? p.result;
        const job = !p.isError ? jobObservation(tool.name, tool.input, raw) : null;
        if (!job) { state.text = ""; state.jobs.clear(); continue; }
        const sig = digest([tool.name, tool.input, job]);
        let entry = state.jobs.get(job.jobId);
        if (!entry) { if (state.jobs.size >= 64) state.jobs.clear(); entry = { signatures: new Map(), repeats: 0 }; state.jobs.set(job.jobId, entry); }
        const key = digest([tool.name, tool.input]);
        if (entry.signatures.get(key) !== sig) {
          if (entry.signatures.size >= 8) entry.signatures.clear();
          entry.signatures.set(key, sig); state.text = "";
          for (const observed of state.jobs.values()) observed.repeats = 0;
        } else {
          entry.repeats++;
          if (entry.repeats >= POLL_REPEATS) return { progress: false, stop: true, kind: "repeated_job_poll", repeats: entry.repeats };
        }
      } else if (draft.type === "assistant.delta" || draft.type === "assistant.thinking.delta") {
        // Foreground work may legitimately narrate a repeated observation; its lease governs liveness.
        if (session._activeTools.size) { state.text = ""; continue; }
        if (state.protectedText) continue;
        const piece = String(p.text || "");
        if (piece.length > MAX_TEXT) state.protectedText = true; // Oversized snapshot: do not infer missing boundaries.
        state.text = `${state.text}${piece}`.slice(-MAX_TEXT);
        if (/```|~~~|(?:^|\n)\s*(?:>|["“]|[-*]\s|\d+[.)]\s)/u.test(state.text)) state.protectedText = true;
        if (state.protectedText) continue;
        if (!/[.!?。！？\n]/u.test(piece)) continue;
        const repeats = repeatedText(state.text, String(session._pendingPromptPayload?.text || ""));
        if (repeats) {
          return { progress: false, stop: true, kind: "repeated_text", repeats };
        }
      }
    }
    return baseline;
  } catch { states.delete(session._turnGates); return baseline; }
}

function stopTurnLoop(session, decision) {
  if (!session.busy || session._turnSettled || session._turnGates.loopStopping || session._pendingPermissions.size || session._pendingQuestions.size) return;
  const owner = session._turnGates;
  owner.loopStopping = true;
  const server = session._server;
  session._abortSettling = true;
  void (async () => {
    let abortConfirmed = false;
    try { if (server) { await session._abortWithTimeout(server); abortConfirmed = true; } } catch { /* bounded adapter retirement handled by the session */ }
    const invalidate = !abortConfirmed && !session._server && !session._starting
      && (session._turnGates === owner || !session.busy)
      && (!session.agentResumeId || session.agentResumeId === server?.sessionID);
    if (invalidate) {
      // Also applies when user stop won during abort; never mutate a newer runner.
      server?.removeAllListeners?.("event");
      session.agentResumeId = null; session._engineSessionWasResumed = false;
      require("./opencode-runtime-identity").revokeOpencodeRuntimeIdentity(session, server?.sessionID || "", "loop_abort_unconfirmed");
    }
    const notifyInvalidated = () => { if (invalidate) session.emit("engine-session-invalidated", { reason: "loop_abort_unconfirmed", previousResumeId: server?.sessionID || "", resetResume: true }); };
    if (session._turnGates !== owner || !session.busy || session._turnSettled) {
      if (!session.busy && (session._server === server || !session._server)) session._abortSettling = false;
      notifyInvalidated();
      return;
    }
    session._abortSettling = false;
    const note = !abortConfirmed
      ? "检测到重复输出，已暂停本轮接收并保留已有内容，但未能确认引擎已停止。后台操作状态需要检查；不会自动重放之前的操作。"
      : decision.kind === "repeated_job_poll"
        ? "检测到反复查询同一后台任务，但没有新的进展，已暂停本轮自动检查。已有输出已保留；后台任务未被停止，稍后可继续检查。"
        : "检测到连续重复输出且没有新的进展，已停止本轮生成并保留已有内容。你可以补充要求后继续；不会自动重放之前的操作。";
    session._settleTurn({ code: 0, stalled: true, output: [session.collectedOutput.trim(), note].filter(Boolean).join("\n\n"),
      loopDetected: { kind: decision.kind, repeats: decision.repeats, abortConfirmed } });
    notifyInvalidated();
  })();
}

module.exports = { observeTurnLoop, stopTurnLoop };
