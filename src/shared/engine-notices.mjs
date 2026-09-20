/**
 * Engine notices — the catalogue of what the platform tells the user about a
 * running turn, and the one place their shape comes from.
 *
 * Twenty-eight sites in eighteen modules built `{ code, level, panel, replace,
 * replacesCode, done, detail }` by hand. Each author had to remember every
 * field: `detail` was missing at eight of them (the vision "skipped" chip
 * carried no reason for eleven days), `panel` at some, and the renderer kept a
 * second copy of the visibility policy "to be kept in sync" by reading the
 * main-process file. A notice's phase semantics — what it replaces, whether it
 * is a live progress line, whether it ends a phase — belong to its CODE, so
 * they are declared once here and a site says only what is specific to the
 * moment: the code and its detail.
 *
 * ESM shared by both processes (the renderer imports it, the main process
 * requires it).
 */

/** "self": the notice replaces an earlier notice with the same code. */
const SELF = "self";

export const NOTICE_CODES = Object.freeze({
  // ---- preflight phases: preparing → ready | skipped -----------------------
  visionPreparing: { level: "progress", panel: true, live: true, replaces: SELF },
  visionReady: { level: "info", panel: true, done: true, replaces: "visionPreparing" },
  visionSkipped: { level: "warning", panel: true, done: true, replaces: "visionPreparing" },
  documentPreparing: { level: "progress", panel: true, live: true, replaces: SELF },
  documentReady: { level: "info", panel: true, done: true, replaces: "documentPreparing" },
  documentSkipped: { level: "warning", panel: true, done: true, replaces: "documentPreparing" },
  // Generic progress inside a phase; the site names the slot it fills (a
  // preparing phase, a runtime pack, a tool call).
  workProgress: { level: "progress", panel: true, live: true },
  legalKnowledgePackProgress: { level: "progress", panel: true, replaces: SELF },
  // ---- context compaction ----------------------------------------------------
  // The "compacted" line replaces the "preparing" line: the site says done+info.
  compactBoundary: { level: "progress", panel: true, live: true, done: false, replaces: SELF },
  compactFailed: { level: "info", panel: true, done: true, replaces: "compactBoundary" },
  // ---- engine liveness (one shared slot: they swap in place, never stack) ----
  toolProgress: { level: "progress", panel: true, live: true, replaces: "genericToolProgress" },
  awaitingUser: { level: "progress", panel: true, replaces: "genericToolProgress" },
  engineRetry: { level: "progress", panel: true, replaces: "genericToolProgress" },
  longWait: { level: "progress", panel: true, live: true, replaces: SELF },
  waitingForFirstResponse: { level: "progress", panel: true, live: true },
  shellLongRunning: { level: "progress", panel: true, live: true },
  // ---- tasks and subagents ---------------------------------------------------
  taskProgress: { level: "progress", panel: true, live: true },
  taskCompleted: { level: "progress", panel: true, live: true },
  subagentSlow: { level: "progress", panel: true, live: true },
  subagentVerySlow: { level: "progress", panel: true, live: true },
  subagentCompleted: { level: "progress", panel: true, live: true, done: true },
  subagentEngineError: { level: "warning" },
  parentTaskClosureRecovery: { level: "progress", panel: true, replaces: SELF },
  modelRecoveryWatch: { level: "progress", panel: true, replaces: SELF },
  parentClosureStopped: { level: "warning", panel: true },
  taskContinuationPaused: { level: "warning", panel: true },
  // ---- one-off warnings and informational lines -------------------------------
  permissionAutoDenied: { level: "warning", panel: true, replaces: SELF },
  upstreamAuthFailed: { level: "warning", panel: true },
  platformCapabilitySkillFallback: { level: "warning", panel: true, done: true },
  unknownRuntimeDraft: { level: "warning" },
  stderr: { level: "warning", panel: true, done: false },
  learnedSkillDraft: { level: "info", panel: true, done: true },
  turnSteered: { level: "info" },
  turnPaused: { level: "info" },
  agentBindingChanged: { level: "info", panel: false },
  mediaResultDelivered: { level: "info", panel: false },
  // ---- never shown in the process panel (CLI proxy / engine chatter) ----------
  sentToCli: { level: "info", hidden: true },
  cliOutputReceived: { level: "info", hidden: true },
  thinkingProgress: { level: "progress", hidden: true },
  rateLimit: { level: "warning", hidden: true },
  apiRetry: { level: "warning", hidden: true },
  shellDetached: { level: "info", hidden: true },
  sessionReady: { level: "info", hidden: true },
  orphanRuntimeEvent: { level: "warning", hidden: true },
  controlRequest: { level: "info", hidden: true },
  unknownEvent: { level: "warning", hidden: true },
  toolSummary: { level: "info", hidden: true },
});

/**
 * Build a notice for `code`. The catalogue supplies the phase semantics; the
 * site supplies what is specific to the moment (detail, progress, a dynamic
 * replace slot, and — rarely — a level for a code that reports both progress
 * and failure). An unknown code still yields a plain informational notice:
 * the test suite, not the running app, is where an unknown code fails.
 *
 * @param {string} code
 * @param {{ detail?: string, message?: string, level?: string, panel?: boolean, done?: boolean, replaces?: string, [extra: string]: unknown }} [overrides]
 */
export function engineNotice(code, overrides = {}) {
  const spec = NOTICE_CODES[code] || { level: "info" };
  const { replaces: replacesOverride, replacesCode: legacyReplaces, replace: replaceOverride, ...rest } = overrides;
  const replacesCode = replacesOverride ?? legacyReplaces ?? (spec.replaces === SELF ? code : spec.replaces);
  const notice = { code, level: rest.level ?? spec.level };
  const panel = rest.panel ?? spec.panel;
  if (panel !== undefined) notice.panel = panel;
  const replace = replaceOverride ?? Boolean(replacesCode);
  if (replace) notice.replace = true;
  if (replacesCode) notice.replacesCode = replacesCode;
  const done = rest.done ?? spec.done;
  if (done !== undefined) notice.done = done;
  for (const [key, value] of Object.entries(rest)) {
    if (["level", "panel", "done"].includes(key)) continue;
    if (value !== undefined) notice[key] = value;
  }
  return notice;
}

/** Codes never shown in the process panel. */
export const PANEL_HIDDEN_CODES = Object.freeze(new Set(Object.keys(NOTICE_CODES).filter((code) => NOTICE_CODES[code].hidden)));
/** Progress codes that are live panel lines (other progress notices stay out of the panel). */
export const LIVE_PROGRESS_PANEL_CODES = Object.freeze(new Set(Object.keys(NOTICE_CODES).filter((code) => NOTICE_CODES[code].live)));

export function noticeVisibleInPanel(notice) {
  if (!notice || typeof notice !== "object") return false;
  if (notice.panel === false) return false;
  const code = String(notice.code || "");
  if (PANEL_HIDDEN_CODES.has(code)) return false;
  if (notice.level === "progress" && !LIVE_PROGRESS_PANEL_CODES.has(code)) return false;
  return notice.panel === true || notice.level === "warning";
}

export function sanitizeNoticeForIngest(notice) {
  if (!notice || typeof notice !== "object") return notice;
  if (noticeVisibleInPanel(notice)) return notice;
  return { ...notice, panel: false };
}
