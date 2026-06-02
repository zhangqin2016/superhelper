#!/usr/bin/env node
/**
 * Message queue policy checks (no Electron).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  enqueueMessage,
  dequeueMessage,
  queueLength,
  clearMessageQueue,
  removeQueuedMessage,
  buildQueueState,
  emitQueueState,
} = require("../src/main/turn-message-queue.js");
const { shouldQueueUserLine } = require("../src/main/ipc-utils.js");
const { turnController } = require("../src/main/turn-controller.js");

const sid = "sess_queue_test";

clearMessageQueue(sid);
if (queueLength(sid) !== 0) throw new Error("empty queue expected");

const len = enqueueMessage(sid, {
  text: "first",
  files: [],
  displayFiles: [{ name: "a.txt" }],
});
if (len !== 1) throw new Error(`expected queue length 1, got ${len}`);

const item = dequeueMessage(sid);
if (!item || item.text !== "first" || !item.id) throw new Error("dequeue mismatch");
if (queueLength(sid) !== 0) throw new Error("queue should be empty after dequeue");

enqueueMessage(sid, { text: "a", files: [], displayFiles: [] });
enqueueMessage(sid, { text: "b", files: [], displayFiles: [] });
if (!removeQueuedMessage(sid, 0)) throw new Error("remove index 0 failed");
if (queueLength(sid) !== 1) throw new Error("expected 1 item after remove");
const state = buildQueueState(sid);
if (state.queueLength !== 1 || state.items[0]?.preview !== "b") {
  throw new Error("buildQueueState mismatch");
}
clearMessageQueue(sid);

let emitted = null;
emitQueueState(
  { mainWindow: { isDestroyed: () => false, webContents: { send: (_ch, data) => { emitted = data; } } } },
  sid,
);
if (!emitted || emitted.sessionId !== sid) throw new Error("emitQueueState failed");

const busyRunner = { isBusy: () => true };
if (!shouldQueueUserLine(sid, busyRunner, {})) {
  throw new Error("busy runner should queue");
}
if (shouldQueueUserLine(sid, busyRunner, { fromQueue: true })) {
  throw new Error("fromQueue should not re-queue");
}

turnController.transition(sid, "userSend");
turnController.transition(sid, "engineAccepted");
turnController.completeTurn(sid, "completed");
if (!shouldQueueUserLine(sid, { isBusy: () => false }, {})) {
  throw new Error("closing turn should queue direct user send");
}
turnController.finalizeTurn(sid);

console.log("turn-message-queue: ok");
