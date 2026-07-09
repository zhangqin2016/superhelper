/** Minimal liveTurn for assistant messages saved before TurnRecord existed. */
export function legacyLiveTurnFromMessage(message) {
  const ts = message?.timestamp ? Date.parse(message.timestamp) : Date.now();
  const safeTs = Number.isFinite(ts) ? ts : Date.now();
  const terminal = message?.failed
    ? "turn.failed"
    : message?.meta?.terminal || "turn.completed";
  return {
    turnId: message?.turnId || message?.id || `legacy_${safeTs}`,
    phase: "done",
    assistantText: message?.content || "",
    thinkingText: "",
    contentBlocks: [],
    artifacts: [],
    protocolUnknown: [],
    processEvents: [],
    timeline: [],
    activityLabel: null,
    livenessNotice: null,
    durationMs: null,
    totalCostUsd: null,
    usage: null,
    taskRun: message?.record?.meta?.taskRun || message?.meta?.taskRun || null,
    tools: new Map(),
    resultBlocks: [],
    notices: [],
    permissions: new Map(),
    questions: new Map(),
    hooks: new Map(),
    startedAt: safeTs,
    updatedAt: safeTs,
    final: {
      type: terminal,
      payload: { assistant: message?.content || "" },
      ts: safeTs,
    },
    finalRendered: false,
  };
}

export function liveTurnFromRecord(record) {
  const tools = new Map();
  for (const tool of record?.tools || []) {
    if (tool?.id) tools.set(tool.id, tool);
  }
  const processEvents = (record?.processEvents || []).map((payload) => ({
    type: "process.event",
    payload: payload?.payload || payload,
  }));
  const notices = (record?.notices || []).map((event) => (
    event?.type ? event : { type: "engine.notice", payload: { notice: event } }
  ));
  return {
    turnId: record.turnId,
    phase: "done",
    assistantText: record.assistantText || "",
    thinkingText: record.thinkingText || "",
    contentBlocks: record.contentBlocks || [],
    artifacts: record.artifacts || [],
    resultBlocks: record.resultBlocks || [],
    protocolUnknown: record.protocolUnknown || [],
    processEvents,
    timeline: record.timeline || [],
    activityLabel: record.activityLabel || null,
    livenessNotice: null,
    durationMs: record.durationMs ?? null,
    totalCostUsd: record.totalCostUsd ?? null,
    usage: record.usage ?? null,
    taskRun: record.meta?.taskRun || null,
    tools,
    fileChanges: record.fileChanges || [],
    notices,
    permissions: new Map(),
    questions: new Map(),
    hooks: new Map(),
    startedAt: record.startedAt || Date.now(),
    updatedAt: record.endedAt || Date.now(),
    final: {
      type: record.terminal || "turn.completed",
      payload: { assistant: record.assistantText || "" },
      ts: record.endedAt || Date.now(),
    },
    finalRendered: false,
  };
}
