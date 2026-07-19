export function removeSupersededAssistant(runtime, turnId = "") {
  if (!runtime || !turnId || !Array.isArray(runtime.committedMessages)) return false;
  const before = runtime.committedMessages.length;
  runtime.committedMessages = runtime.committedMessages.filter(
    (message) => message?.role !== "assistant" || message?.turnId !== turnId,
  );
  return runtime.committedMessages.length < before;
}
