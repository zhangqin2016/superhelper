"use strict";

// Match explicit upstream refresh rejection, not a customer's ordinary API-key
// error or a refresh attempt that failed transiently (e.g. timeout/503).
const UPSTREAM_AUTH_RE = /token refresh failed\s*\(\s*401\s*\)|UPSTREAM_MODEL_AUTH_FAILED|模型网关的上游账号认证已失效/i;
const UPSTREAM_AUTH_FAILURE = Object.freeze({
  code: "UPSTREAM_MODEL_AUTH_FAILED",
  category: "auth",
  test: UPSTREAM_AUTH_RE,
  message: "模型网关的上游账号认证已失效，令牌刷新被拒绝（401）。请由网关管理员重新授权上游账号，恢复后再重试。本轮已停止自动重试。",
  retryable: false,
});

function settleUpstreamAuthFailure(session, message, cause) {
  const raw = cause?.data?.message || cause?.message || message;
  if (!UPSTREAM_AUTH_RE.test(String(raw || ""))) return false;
  if (!session.busy || session._turnSettled || session._turnGates.loopStopping) return true;
  const server = session._server;
  const gates = session._turnGates;
  session._turnGates.loopStopping = true;
  session._clearIdleSettleTimer();
  session._pendingCompletePayload = null;
  session._clearTransientFailureTimer();
  session._ingest([{ type: "engine.notice", payload: { notice: {
    code: "upstreamAuthFailed", level: "warning", panel: true,
    detail: UPSTREAM_AUTH_FAILURE.message,
  } } }]);
  // Keep the turn busy until its abort settles, so a new prompt cannot race the
  // old abort. Never terminate the shared server or interrupt another session.
  // The SDK abort already has a bounded 10s control-plane timeout.
  void Promise.resolve().then(() => server?.abort?.()).catch(() => false).then(() => {
    if (session._turnSettled || session._turnGates !== gates || session._server !== server) return;
    session._failTurn(UPSTREAM_AUTH_FAILURE.message, null, { force: true, upstreamAuthHandled: true });
  });
  return true;
}

function handleServeDiagnostic(session, info) {
  if (info?.kind !== "upstream_auth") return session._turnLiveness.noteEngineRetry(info);
  // Title/compaction helpers and an earlier request's tail cannot terminate
  // the foreground build. Native message errors retain their existing ownership.
  if (!session.busy || session._turnSettled || info.agent !== "build"
    || info.sessionID !== session._server?.sessionID
    || !Number.isFinite(info.ts) || info.ts < session._turnStartedAt) return;
  settleUpstreamAuthFailure(session, info.error);
}

module.exports = { UPSTREAM_AUTH_RE, UPSTREAM_AUTH_FAILURE, settleUpstreamAuthFailure, handleServeDiagnostic };
