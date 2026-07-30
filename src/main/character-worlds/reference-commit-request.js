"use strict";

const { importError } = require("./file-authority-shared");

function commitUnknownError() {
  return importError(
    "EXPORT_COMMIT_OUTCOME_UNKNOWN",
    "Export commit outcome is not yet known",
  );
}

function signalError() {
  return importError("EXPORT_WRITE_CANCELLED", "Character export was cancelled");
}

function settleCommitResponse(pending, message, stableBrokerError) {
  if (message.ok === true) {
    if (!pending.initialSettled) {
      pending.initialSettled = true;
      pending.initialResolve(message.result);
    }
    pending.outcomeResolve(message.result);
    return;
  }
  const error = stableBrokerError(message.error);
  if (!pending.initialSettled) {
    pending.initialSettled = true;
    pending.initialReject(error);
  }
  pending.outcomeReject(error);
}

function failCommitRequest(pending) {
  const error = commitUnknownError();
  if (!pending.initialSettled) {
    pending.initialSettled = true;
    pending.initialReject(error);
  }
  pending.outcomeReject(error);
}

function failCommitBeforeSend(pending, error) {
  pending.initialSettled = true;
  pending.initialReject(error);
  pending.outcomeReject(error);
}

function operation(id, initial, outcome, requestSent) {
  return Object.freeze({ id, initial, outcome, requestSent });
}

async function beginCommitRequest(
  broker,
  payload,
  { signal, deadline } = {},
  stableBrokerError,
) {
  await broker.ready();
  if (broker.closed || broker.closing) {
    throw importError("EXPORT_DESTINATION_CLOSED", "Destination broker is closed");
  }
  if (signal?.aborted) throw signalError();
  const now = Date.now();
  const requestedDeadline = Number.isFinite(deadline)
    ? Math.trunc(deadline)
    : now + broker.requestTimeoutMs;
  const expiresAt = Math.min(requestedDeadline, now + broker.requestTimeoutMs);
  if (expiresAt <= now) {
    throw importError("EXPORT_BROKER_TIMEOUT", "Destination broker request timed out");
  }

  const id = `${broker.auth.slice(0, 16)}-${++broker.sequence}`;
  let initialResolve;
  let initialReject;
  let outcomeResolve;
  let outcomeReject;
  const initial = new Promise((resolve, reject) => {
    initialResolve = resolve;
    initialReject = reject;
  });
  const outcome = new Promise((resolve, reject) => {
    outcomeResolve = resolve;
    outcomeReject = reject;
  });
  void initial.catch(() => {});
  void outcome.catch(() => {});
  const pending = {
    type: "commit",
    initialSettled: false,
    initialResolve,
    initialReject,
    outcomeResolve,
    outcomeReject,
    signal: null,
    abortListener: null,
    timer: null,
  };
  pending.timer = setTimeout(() => {
    if (broker.pending.get(id) !== pending || pending.initialSettled) return;
    pending.initialSettled = true;
    pending.initialReject(commitUnknownError());
  }, expiresAt - now);
  pending.timer.unref?.();
  broker.pending.set(id, pending);

  if (signal?.aborted) {
    const current = broker._takePending(id);
    const error = signalError();
    current.initialSettled = true;
    current.initialReject(error);
    current.outcomeReject(error);
    return operation(id, initial, outcome, false);
  }
  try {
    broker.child.send({ auth: broker.auth, id, type: "commit", payload }, (error) => {
      if (!error) return;
      const current = broker._takePending(id);
      if (current) failCommitRequest(current);
    });
  } catch (error) {
    const current = broker._takePending(id);
    if (!current) return operation(id, initial, outcome, true);
    failCommitBeforeSend(current, stableBrokerError(error));
    return operation(id, initial, outcome, false);
  }
  return operation(id, initial, outcome, true);
}

module.exports = {
  beginCommitRequest,
  failCommitRequest,
  settleCommitResponse,
};
