const DISPATCH_OUTCOME_UNKNOWN_ASSISTANT = "The durable reply outcome could not be confirmed. Automatic replay is disabled; verify the result before sending again.";
const DISPATCH_BLOCKED_ASSISTANT = "The message was not delivered to the assistant and was not executed. It is safe to retry.";

export function isRecoveryProjectionEvent(event = {}) {
  return event.type === "turn.dispatch_outcome_unknown" || event.type === "turn.dispatch_blocked";
}

export function recoveryRecord(event = {}) {
  const payload = event.payload || {};
  const outcomeUnknown = event.type === "turn.dispatch_outcome_unknown";
  const assistant = String(
    payload.assistant || (outcomeUnknown ? DISPATCH_OUTCOME_UNKNOWN_ASSISTANT : DISPATCH_BLOCKED_ASSISTANT),
  ).trim();
  const ts = Number(event.ts || Date.now());
  return {
    sessionId: event.sessionId,
    turnId: event.turnId,
    startedAt: ts,
    endedAt: ts,
    terminal: event.type,
    assistantText: assistant,
    thinkingText: "",
    contentBlocks: [],
    protocolUnknown: [],
    tools: [],
    fileChanges: [],
    artifacts: [],
    resultBlocks: [],
    timeline: [],
    processEvents: [],
    notices: [],
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
  const record = recoveryRecord(event);
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
