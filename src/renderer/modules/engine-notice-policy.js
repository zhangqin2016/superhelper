// The notice catalogue and its visibility policy live in src/shared/engine-notices.mjs,
// shared with the main process — one policy, not two kept in sync by hand.
export { LIVE_PROGRESS_PANEL_CODES, PANEL_HIDDEN_CODES, noticeVisibleInPanel, sanitizeNoticeForIngest } from "../../shared/engine-notices.mjs";
