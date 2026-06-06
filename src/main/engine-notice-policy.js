"use strict";

/** Notices that must never appear in the chat process panel (CLI proxy mode). */
const PANEL_HIDDEN_CODES = new Set([
  "sentToCli",
  "cliOutputReceived",
  "waitingForFirstResponse",
  "longWait",
  "thinkingProgress",
  "compactBoundary",
  "compactComplete",
  "rateLimit",
  "apiRetry",
  "shellDetached",
  "sessionReady",
  "orphanRuntimeEvent",
  "controlRequest",
  "unknownEvent",
  "toolSummary",
]);

const LIVE_PROGRESS_PANEL_CODES = new Set([
  "taskProgress",
  "taskCompleted",
  "toolProgress",
  "shellLongRunning",
]);

function noticeVisibleInPanel(notice) {
  if (!notice || typeof notice !== "object") return false;
  if (notice.panel === false) return false;
  const code = String(notice.code || "");
  if (PANEL_HIDDEN_CODES.has(code)) return false;
  if (notice.level === "progress" && !LIVE_PROGRESS_PANEL_CODES.has(code)) return false;
  return notice.panel === true || notice.level === "warning";
}

function sanitizeNoticeForIngest(notice) {
  if (!notice || typeof notice !== "object") return notice;
  if (noticeVisibleInPanel(notice)) return notice;
  return { ...notice, panel: false };
}

module.exports = {
  LIVE_PROGRESS_PANEL_CODES,
  PANEL_HIDDEN_CODES,
  noticeVisibleInPanel,
  sanitizeNoticeForIngest,
};
