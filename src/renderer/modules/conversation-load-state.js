// Request-owned state: a late load must not settle a newer load for the same chat.
const loads = new Map();

export function beginConversationLoad(sessionId) {
  const request = { status: "loading" };
  loads.set(sessionId, request);
  return request;
}

export function finishConversationLoad(sessionId, request, ok) {
  if (loads.get(sessionId) !== request) return false;
  request.status = ok ? "ready" : "error";
  return true;
}

export function conversationLoadStatus(sessionId) {
  return loads.get(sessionId)?.status || "ready";
}
