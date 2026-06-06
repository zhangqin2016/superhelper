#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  noticeVisibleInPanel,
  sanitizeNoticeForIngest,
} from "../src/main/engine-notice-policy.js";

assert.equal(noticeVisibleInPanel({ code: "waitingForFirstResponse", level: "progress", panel: true }), true);
assert.equal(noticeVisibleInPanel({ code: "permissionDenied", level: "warning", panel: true }), true);
assert.equal(sanitizeNoticeForIngest({ code: "longWait", level: "progress", panel: true }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "permissionDenied", level: "warning", panel: true }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "taskProgress", level: "progress", panel: true, detail: "上传 42%" }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "toolProgress", level: "progress", panel: true, detail: "uploaded 42%" }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "shellLongRunning", level: "progress", panel: true, detail: "curl upload" }).panel, true);
assert.equal(sanitizeNoticeForIngest({ code: "thinkingProgress", level: "progress", panel: true, detail: "42 tokens" }).panel, false);

console.log("test-engine-notice-policy: ALL_OK");
