"use strict";

const { randomUUID } = require("node:crypto");

/** @type {Map<string, Array<{ id: string, text: string, files: unknown[], displayFiles: unknown[] }>>} */
const queues = new Map();

function getQueue(sessionId) {
  if (!queues.has(sessionId)) queues.set(sessionId, []);
  return queues.get(sessionId);
}

function previewQueuedItem(item) {
  const text = String(item.text || "").trim().replace(/\s+/g, " ");
  if (text) {
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  const names = (item.displayFiles || item.files || [])
    .map((f) => f?.name)
    .filter(Boolean);
  if (names.length) return names.join(", ");
  return "";
}

function buildQueueState(sessionId) {
  const queue = queues.get(sessionId) || [];
  return {
    sessionId,
    queueLength: queue.length,
    items: queue.map((item, index) => ({
      index,
      id: item.id,
      preview: previewQueuedItem(item),
      hasFiles: Boolean(item.files?.length || item.displayFiles?.length),
    })),
  };
}

/**
 * @param {string} sessionId
 * @param {{ text: string, files?: unknown[], displayFiles?: unknown[] }} item
 */
function enqueueMessage(sessionId, item) {
  const queue = getQueue(sessionId);
  queue.push({
    id: randomUUID(),
    text: String(item.text || "").trim(),
    files: Array.isArray(item.files) ? item.files : [],
    displayFiles: Array.isArray(item.displayFiles) ? item.displayFiles : [],
  });
  return queue.length;
}

function queueLength(sessionId) {
  return getQueue(sessionId).length;
}

function clearMessageQueue(sessionId) {
  queues.delete(sessionId);
}

/**
 * @param {string} sessionId
 * @param {number} index
 */
function removeQueuedMessage(sessionId, index) {
  const queue = queues.get(sessionId);
  if (!queue || index < 0 || index >= queue.length) return false;
  queue.splice(index, 1);
  if (queue.length === 0) queues.delete(sessionId);
  return true;
}

/**
 * @param {string} sessionId
 */
function dequeueMessage(sessionId) {
  const queue = getQueue(sessionId);
  const item = queue.shift();
  if (queue.length === 0) queues.delete(sessionId);
  return item || null;
}

function emitQueueState(ctx, sessionId) {
  if (!sessionId || !ctx?.mainWindow || ctx.mainWindow.isDestroyed()) return;
  ctx.mainWindow.webContents.send("assistant:queue-state", buildQueueState(sessionId));
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 */
function requeueFront(sessionId, item) {
  if (!item) return;
  getQueue(sessionId).unshift(item);
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 */
function takeQueueItemIfIdle(ctx, sessionId) {
  const { runnerPool } = ctx;
  const { isRecoveryPending } = require("./turn-auto-recovery");
  const { turnController } = require("./turn-controller");

  if (!sessionId || queueLength(sessionId) === 0) return null;

  const runner = runnerPool.get(sessionId);
  if (runner?.isBusy() || isRecoveryPending(sessionId)) return null;

  const phase = turnController.snapshot(sessionId).phase;
  if (phase !== "idle" && phase !== "closing") return null;

  return dequeueMessage(sessionId);
}

module.exports = {
  enqueueMessage,
  dequeueMessage,
  queueLength,
  clearMessageQueue,
  removeQueuedMessage,
  requeueFront,
  takeQueueItemIfIdle,
  buildQueueState,
  emitQueueState,
};
