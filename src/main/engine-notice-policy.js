"use strict";

/** Notices that must never appear in the chat process panel (CLI proxy mode). */
const PANEL_HIDDEN_CODES = new Set([
  "sentToCli",
  "cliOutputReceived",
  "waitingForFirstResponse",
  "longWait",
  "thinkingProgress",
  "taskProgress",
  "taskCompleted",
  "compactBoundary",
  "compactComplete",
  "rateLimit",
  "apiRetry",
  "shellDetached",
  "shellLongRunning",
  "sessionReady",
  "orphanRuntimeEvent",
  "controlRequest",
  "unknownEvent",
  "toolSummary",
]);

function noticeVisibleInPanel(notice) {
  if (!notice || typeof notice !== "object") return false;
  if (notice.panel === false) return false;
  if (PANEL_HIDDEN_CODES.has(String(notice.code || ""))) return false;
  if (notice.level === "progress") return false;
  return notice.panel === true || notice.level === "warning";
}

function sanitizeNoticeForIngest(notice) {
  if (!notice || typeof notice !== "object") return notice;
  if (noticeVisibleInPanel(notice)) return notice;
  return { ...notice, panel: false };
}

module.exports = {
  PANEL_HIDDEN_CODES,
  noticeVisibleInPanel,
  sanitizeNoticeForIngest,
};
