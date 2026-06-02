#!/usr/bin/env node
/**
 * Priority send checks: interrupt current turn, discard old queue, then start
 * the new question only after the interrupted boundary finalizes.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { turnController } = require("../src/main/turn-controller.js");
const {
  clearMessageQueue,
  enqueueMessage,
  queueLength,
} = require("../src/main/turn-message-queue.js");
const { interruptAndSend } = require("../src/main/interrupt-and-send.js");

const sid = "sess_interrupt_send_test";
const session = { id: sid };
const sends = [];
const pushed = [];
let interrupted = false;
let phaseAtQueuedDispatch = null;
let dispatchedText = null;

const ipcUtils = require("../src/main/ipc-utils.js");
ipcUtils.diagnoseSendBlocker = () => null;
ipcUtils.dispatchUserLine = async (_ctx, _session, text, _files, opts) => {
  phaseAtQueuedDispatch = turnController.snapshot(sid).phase;
  dispatchedText = text;
  if (!opts.fromQueue) throw new Error("priority message should dispatch from queue");
  turnController.transition(sid, "userSend");
  return {
    ok: true,
    userCommitted: { text, files: null },
  };
};

const ctx = {
  mainWindow: {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        sends.push({ channel, payload });
      },
    },
  },
  sessionManager: {
    findById: (sessionId) => (sessionId === sid ? session : null),
    pushMessageTo: (sessionId, role, content) => {
      pushed.push({ sessionId, role, content });
    },
  },
  runnerPool: {
    get: () => ({
      isBusy: () => false,
      interrupt: () => {
        interrupted = true;
      },
    }),
  },
};

clearMessageQueue(sid);
enqueueMessage(sid, { text: "old queued", files: [], displayFiles: [] });

turnController.transition(sid, "userSend");
turnController.transition(sid, "engineAccepted");
turnController.appendOutput(sid, "partial output");

const result = await interruptAndSend(ctx, session, "urgent follow-up", [], {
  displayFiles: [],
});

if (!result.ok || !result.priority || !result.queued) {
  throw new Error("priority send should return queued priority result");
}
if (!interrupted) throw new Error("runner should be interrupted");
if (phaseAtQueuedDispatch !== "idle") {
  throw new Error(`priority dispatch must start after finalize, got ${phaseAtQueuedDispatch}`);
}
if (dispatchedText !== "urgent follow-up") {
  throw new Error(`expected urgent follow-up to dispatch, got ${dispatchedText}`);
}
if (queueLength(sid) !== 0) {
  throw new Error("priority dispatch should consume the new queue and discard old queue");
}
if (pushed[0]?.role !== "assistant" || pushed[0]?.content !== "partial output") {
  throw new Error("interrupted partial output should be persisted once");
}

const batch = sends.find((s) => s.channel === "assistant:session-events")?.payload;
if (!batch) throw new Error("missing session-events batch");
if (batch.events[0]?.type !== "turn-ended") throw new Error("turn-ended must be first");
if (batch.events[0]?.endReason !== "interrupted") {
  throw new Error("priority send must end current turn as interrupted");
}
if (batch.events[1]?.type !== "user-committed") {
  throw new Error("priority user should be committed after interrupted boundary");
}
if (batch.events[1]?.text !== "urgent follow-up" || !batch.events[1]?.fromQueue) {
  throw new Error("priority user event mismatch");
}

const finalPhase = turnController.snapshot(sid).phase;
if (finalPhase !== "sending") {
  throw new Error(`priority dispatch should begin next turn, got ${finalPhase}`);
}

console.log("interrupt-and-send: ok");
