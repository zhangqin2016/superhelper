"use strict";

// The notice catalogue and its visibility policy live in
// src/shared/engine-notices.mjs, shared with the renderer — one policy, not
// two kept in sync by hand. Re-exported name by name so ESM importers of this
// CommonJS module still see named exports.
const shared = require("../shared/engine-notices.mjs");

exports.NOTICE_CODES = shared.NOTICE_CODES;
exports.engineNotice = shared.engineNotice;
exports.LIVE_PROGRESS_PANEL_CODES = shared.LIVE_PROGRESS_PANEL_CODES;
exports.PANEL_HIDDEN_CODES = shared.PANEL_HIDDEN_CODES;
exports.noticeVisibleInPanel = shared.noticeVisibleInPanel;
exports.sanitizeNoticeForIngest = shared.sanitizeNoticeForIngest;
