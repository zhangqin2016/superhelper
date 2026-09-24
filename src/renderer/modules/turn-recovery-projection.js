const DISPATCH_OUTCOME_UNKNOWN_ASSISTANT = "The durable reply outcome could not be confirmed. Automatic replay is disabled; verify the result before sending again.";
const DISPATCH_BLOCKED_ASSISTANT = "The message was not delivered to the assistant and was not executed. It is safe to retry.";

export function isRecoveryProjectionEvent(event = {}) {
  return event.type === "turn.dispatch_outcome_unknown" || event.type === "turn.dispatch_blocked";
}

// What the turn produced before its outcome became unknown. The recovery
// notice used to REPLACE it — a turn that had streamed for half an hour closed
// as one sentence, while the live turn holding every word and step was right
// here. The main-process projection keeps the same rule (turn-projection-reducer).
function producedSoFar(live) {
  if (!live || typeof live !== "object") return { text: "", thinking: "", timeline: [], tools: [] };
  const tools = live.tools instanceof Map ? [...live.tools.values()] : Array.isArray(live.tools) ? live.tools : [];
  const stopped = (entry) => (entry?.status === "running" ? { ...entry, status: "interrupted" } : entry);
  return {
    text: String(live.assistantText || "").trim(),
    thinking: String(live.thinkingText || ""),
    timeline: (Array.isArray(live.timeline) ? live.timeline : []).map((entry) => (
      entry?.status === "streaming" ? { ...entry, status: "done" } : stopped(entry)
    )),
    tools: tools.map(stopped),
  };
}

export function recoveryRecord(event = {}, live = null) {
  const payload = event.payload || {};
  const outcomeUnknown = event.type === "turn.dispatch_outcome_unknown";
  const notice = String(
    payload.assistant || (outcomeUnknown ? DISPATCH_OUTCOME_UNKNOWN_ASSISTANT : DISPATCH_BLOCKED_ASSISTANT),
  ).trim();
  const produced = producedSoFar(live);
  const ts = Number(event.ts || Date.now());
  return {
    sessionId: event.sessionId,
    turnId: event.turnId,
    startedAt: Number(live?.startedAt) || ts,
    endedAt: ts,
    terminal: event.type,
    assistantText: produced.text || notice,
    thinkingText: produced.thinking,
    contentBlocks: [],
    protocolUnknown: [],
    tools: produced.tools,
    fileChanges: [],
    artifacts: [],
    resultBlocks: [],
    timeline: produced.timeline,
    processEvents: [],
    notices: produced.text
      ? [{ code: outcomeUnknown ? "dispatchOutcomeUnknown" : "dispatchBlocked", level: "warning", detail: notice }]
      : [],
    usage: null,
    meta: {
      outcomeUnknown,
      dispatchBlocked: !outcomeUnknown,
      manualRecoveryRequired: payload.manualRecoveryRequired !== false,
      automaticReplay: payload.automaticReplay === true,
      recoveryId: payload.recoveryId || "",
      errorCode: payload.errorCode || (outcomeUnknown ? "DISPATCH_OUTCOME_UNKNOWN" : "DISPATCH_BLOCKED"),
      retryable: payload.retryable !== false && !outcomeUnknown,
      projected: true,
    },
  };
}

export function closeRecoveryProjection({ runtime, live, event, turnKey, recoveryTurns, upsertCommittedMessage }) {
  const record = recoveryRecord(event, live);
  const assistant = record.assistantText;
  live.phase = "done";
  live.recoveryEvent = null;
  live.final = { ...event, payload: { ...(event.payload || {}), assistant, record } };
  runtime.phase = "idle";
  runtime.turnId = null;
  runtime._turnStartedAt = 0;
  recoveryTurns.add(turnKey);
  upsertCommittedMessage(runtime, {
    role: "assistant",
    content: assistant,
    record,
    failed: true,
    turnId: event.turnId,
    timestamp: new Date(event.ts).toISOString(),
    meta: record.meta,
  });
}
