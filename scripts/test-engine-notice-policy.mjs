#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  noticeVisibleInPanel,
  sanitizeNoticeForIngest,
} from "../src/main/engine-notice-policy.js";
import {
  noticeVisibleInPanel as rendererNoticeVisibleInPanel,
  sanitizeNoticeForIngest as rendererSanitizeNoticeForIngest,
} from "../src/renderer/modules/engine-notice-policy.js";

assert.equal(noticeVisibleInPanel({ code: "waitingForFirstResponse", level: "progress", panel: true }), true);
assert.equal(noticeVisibleInPanel({ code: "permissionDenied", level: "warning", panel: true }), true);
assert.equal(sanitizeNoticeForIngest({ code: "longWait", level: "progress", panel: true }).panel, false);
assert.equal(sanitizeNoticeForIngest({ code: "permissionDenied", level: "warning", panel: true }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "taskProgress", level: "progress", panel: true, detail: "上传 42%" }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "toolProgress", level: "progress", panel: true, detail: "uploaded 42%" }).panel, false);
assert.equal(sanitizeNoticeForIngest({ code: "documentPreparing", level: "progress", panel: true, detail: "准备文档" }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "workProgress", level: "progress", panel: true, detail: "索引 1/3" }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "shellLongRunning", level: "progress", panel: true, detail: "curl upload" }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "thinkingProgress", level: "progress", panel: true, detail: "42 tokens" }).panel, false);
assert.equal(rendererSanitizeNoticeForIngest({ code: "longWait", level: "progress", panel: true }).panel, false);
assert.equal(rendererSanitizeNoticeForIngest({ code: "toolProgress", level: "progress", panel: true, detail: "uploaded 42%" }).panel, false);
assert.equal(rendererSanitizeNoticeForIngest({ code: "workProgress", level: "progress", panel: true, detail: "索引 1/3" }).panel, true);
assert.equal(rendererSanitizeNoticeForIngest({ code: "documentPreparing", level: "progress", panel: true, detail: "准备文档" }).panel, true);
assert.equal(rendererSanitizeNoticeForIngest({ code: "thinkingProgress", level: "progress", panel: true, detail: "42 tokens" }).panel, false);

// Context compaction must stay user-visible — it explains why the assistant
// may have lost earlier conversation detail.
assert.equal(noticeVisibleInPanel({ code: "compactBoundary", level: "progress", panel: true }), true);
assert.equal(rendererNoticeVisibleInPanel({ code: "compactBoundary", level: "progress", panel: true }), true);
assert.equal(noticeVisibleInPanel({ code: "compactComplete", level: "info", panel: true }), true);
assert.equal(noticeVisibleInPanel({ code: "compactFailed", level: "info", panel: true, done: true }), true);

console.log("test-engine-notice-policy: ALL_OK");
