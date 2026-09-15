/**
 * Platform notices that arrive as runtime events but are really committed
 * transcript messages (the main process already persisted them). They bypass
 * the live-turn projection: the message is upserted into the committed list
 * and the event is otherwise NOT treated as an engine notice (no timeline
 * entry, no activity label).
 *
 *   - long_task_supervisor / parent_closure_recovery "engine.warning" with a
 *     taskContinuation status → the paused/stopped card + failed attention.
 *   - agent_binding "engine.notice" agentBindingChanged → the agent
 *     activated / deactivated / replaced-by-role card (informational).
 *
 * Returns true when the event was consumed.
 */
export function ingestPlatformNoticeEvent(event, runtime, upsertCommittedMessage) {
  const code = event?.payload?.notice?.code;
  const message = event?.payload?.committedMessage;
  if (event?.type === "engine.warning" && ["long_task_supervisor", "parent_closure_recovery"].includes(event.source)
    && ["taskContinuationPaused", "parentClosureStopped"].includes(code)) {
    if (message?.role === "assistant" && typeof message.id === "string"
      && ["paused", "stopped", "not_started"].includes(message.meta?.taskContinuation?.status)) {
      upsertCommittedMessage(runtime, message);
      runtime.attention = "failed";
    }
    return true;
  }
  if (event?.type === "engine.notice" && event.source === "agent_binding" && code === "agentBindingChanged") {
    if (message?.role === "assistant" && message.meta?.agentBinding && typeof message.meta.agentBinding === "object") {
      upsertCommittedMessage(runtime, message);
    }
    return true;
  }
  return false;
}
