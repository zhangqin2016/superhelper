"use strict";

function nowMs() {
  return Date.now();
}

function safeText(value, limit = 500) {
  return String(value || "").trim().slice(0, limit);
}

function touch(taskRun, ts = nowMs()) {
  if (!taskRun) return null;
  taskRun.updatedAt = ts;
  taskRun.lastActivityAt = ts;
  return taskRun;
}

module.exports = { nowMs, safeText, touch };
