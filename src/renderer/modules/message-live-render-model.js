export function runtimeVisualSig(runtime = {}) {
  const live = runtime.liveTurn;
  if (!live) return `idle:${runtime.phase}:${runtime.committedMessages?.length || 0}`;
  const toolSig = [...(live.tools || new Map()).values()]
    .map((tool) => `${tool.id}:${tool.status || ""}`)
    .join(",");
  const subagentSig = [...(live.subagents || new Map()).values()]
    .map((item) => {
      const current = (item.tools || []).find((tool) => tool.id === item.currentToolId) || (item.tools || []).at?.(-1) || {};
      return [
        item.sessionId,
        item.status || "",
        item.phase || "",
        item.phaseDetail || "",
        current.id || "",
        current.status || "",
        current.name || "",
        item.textPreview?.length || 0,
        item.stats?.runningTools || 0,
        item.stats?.doneTools || 0,
        item.stats?.nestedTasks || 0,
      ].join(":");
    })
    .join(",");
  // Deliberately not keyed on elapsed time. The live turn does not show a
  // per-second clock, so elapsed time must not force full rerenders.
  return [
    live.turnId,
    live.phase,
    live.final?.type || "",
    live.assistantText?.length || 0,
    live.thinkingText?.length || 0,
    live.activityLabel || "",
    live.timeline?.length || 0,
    toolSig,
    subagentSig,
    live.permissions?.size || 0,
    live.questions?.size || 0,
    live.hooks?.size || 0,
    runtime.queue?.length || 0,
  ].join("|");
}

export function shouldThrottleLiveRender(runtime = {}) {
  return Boolean(
    runtime.liveTurn &&
    !runtime.liveTurn.final &&
    ["starting", "streaming", "tool_running"].includes(runtime.phase),
  );
}

export function shouldFollowLiveRender({
  preserveScroll = false,
  activeSession = false,
  userScrollDetached = true,
  nearBottom = false,
} = {}) {
  return Boolean(!preserveScroll && activeSession && !userScrollDetached && nearBottom);
}

export function hasCommittedScheduledDraftTurn(runtime = {}, turnId = "") {
  return Boolean(turnId) && (runtime.committedMessages || []).some(
    (message) => message.turnId === turnId &&
      message.role === "assistant" &&
      message.meta?.scheduledDraft,
  );
}

function committedMessageTurnId(message = {}) {
  return message.turnId || message.record?.turnId || "";
}

export function hasCommittedAssistantTurn(runtime = {}, turnId = "") {
  return Boolean(turnId) && (runtime.committedMessages || []).some(
    (message) => committedMessageTurnId(message) === turnId &&
      message.role === "assistant",
  );
}

export function liveTurnRenderMode(runtime = {}) {
  const turnId = runtime.liveTurn?.turnId || "";
  if (!turnId) return "none";
  if (runtime.liveTurn?.final && hasCommittedAssistantTurn(runtime, turnId)) return "remove-duplicate";
  return hasCommittedScheduledDraftTurn(runtime, turnId) ? "remove-duplicate" : "render";
}

export function shouldUpdateConversationMinimap({
  activeSession = false,
  panelConnected = false,
  panelActive = false,
  samePanel = false,
} = {}) {
  return Boolean(activeSession && panelConnected && panelActive && samePanel);
}
