#!/usr/bin/env node
/**
 * Turn boundary tests: finalize before queue handoff, ordered event batch.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { turnController } = require("../src/main/turn-controller.js");
const { enqueueMessage, clearMessageQueue } = require("../src/main/turn-message-queue.js");
const { emitTurnBoundary } = require("../src/main/turn-boundary.js");

const sid = "sess_boundary_test";
const sends = [];
let phaseAtQueuedDispatch = null;

const ipcUtilsPath = require.resolve("../src/main/ipc-utils.js");
const ipcUtils = require(ipcUtilsPath);
ipcUtils.dispatchUserLine = async (_ctx, _session, text, _files, opts) => {
  phaseAtQueuedDispatch = turnController.snapshot(sid).phase;
  if (!opts.fromQueue) throw new Error("expected queued dispatch");
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
    findById: (sessionId) => (sessionId === sid ? { id: sid } : null),
  },
  runnerPool: {
    get: () => ({ isBusy: () => false }),
  },
};

clearMessageQueue(sid);
enqueueMessage(sid, { text: "queued next", files: [], displayFiles: [] });

turnController.transition(sid, "userSend");
turnController.transition(sid, "engineAccepted");
turnController.appendOutput(sid, "final answer");
const { turnId } = turnController.completeTurn(sid, "completed");

await emitTurnBoundary(ctx, sid, {
  turnId,
  endReason: "completed",
  assistant: { text: "final answer", failed: false },
  hadOutput: true,
});

if (phaseAtQueuedDispatch !== "idle") {
  throw new Error(`queued dispatch must start after finalize, got ${phaseAtQueuedDispatch}`);
}

const batch = sends.find((s) => s.channel === "assistant:session-events")?.payload;
if (!batch) throw new Error("missing session-events batch");
if (batch.events.length !== 2) {
  throw new Error(`expected turn-ended + user-committed, got ${batch.events.length}`);
}
if (batch.events[0].type !== "turn-ended") throw new Error("turn-ended must be first");
if (batch.events[1].type !== "user-committed") throw new Error("queued user must be second");
if (!batch.events[1].fromQueue) throw new Error("queued user should be marked fromQueue");

const finalPhase = turnController.snapshot(sid).phase;
if (finalPhase !== "sending") {
  throw new Error(`queued dispatch should begin next turn, got ${finalPhase}`);
}

console.log("test-turn-boundary: ok");
