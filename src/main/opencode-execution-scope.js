"use strict";

// An asynchronous observation may commit only to the execution that requested it.
function captureExecutionScope(runner, { allowServerReplacement = false } = {}) {
  const epoch = runner._executionEpoch;
  const server = runner._server;
  const startedAt = runner._turnStartedAt;
  return () => !runner._turnSettled
    && runner._executionEpoch === epoch
    && (allowServerReplacement || runner._server === server)
    && runner._turnStartedAt === startedAt;
}

module.exports = { captureExecutionScope };
