#!/usr/bin/env node
/**
 * Auto-recovery policy checks (no Electron).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isRecoverableFailure,
  MAX_AUTO_RETRIES,
  recordTurnPayload,
  cancelAutoRecovery,
  scheduleAutoRecovery,
} = require("../src/main/turn-auto-recovery.js");

if (MAX_AUTO_RETRIES !== 2) throw new Error("MAX_AUTO_RETRIES expected 2");

const socketErr =
  "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
if (!isRecoverableFailure(socketErr)) {
  throw new Error("socket error should be recoverable");
}
if (isRecoverableFailure("BUSY")) {
  throw new Error("BUSY should not be recoverable");
}
if (isRecoverableFailure("Failed to resume session abc")) {
  throw new Error("resume failure should not be recoverable");
}

recordTurnPayload("sess_test", { text: "hello", files: [] });
let scheduled = 0;
const ctx = {
  sessionManager: { findById: () => ({ id: "sess_test" }) },
  runnerPool: { terminateSession: () => {} },
};
const meta = {
  sendToRenderer: (_win, channel) => {
    if (channel === "assistant:auto-recover") scheduled += 1;
  },
  mainWindow: null,
};

if (!scheduleAutoRecovery(ctx, "sess_test", socketErr, meta)) {
  throw new Error("first schedule should succeed");
}
if (scheduled !== 1) throw new Error(`expected 1 auto-recover emit, got ${scheduled}`);

cancelAutoRecovery("sess_test");
if (scheduleAutoRecovery(ctx, "sess_test", socketErr, meta)) {
  throw new Error("schedule should fail after cancelAutoRecovery");
}

console.log("turn-auto-recovery: ok");
