#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  noticeVisibleInPanel,
  sanitizeNoticeForIngest,
} from "../src/main/engine-notice-policy.js";

assert.equal(noticeVisibleInPanel({ code: "waitingForFirstResponse", level: "progress", panel: true }), false);
assert.equal(noticeVisibleInPanel({ code: "permissionDenied", level: "warning", panel: true }), true);
assert.equal(sanitizeNoticeForIngest({ code: "longWait", level: "progress", panel: true }).panel, false);
assert.equal(sanitizeNoticeForIngest({ code: "permissionDenied", level: "warning", panel: true }).panel, true);

console.log("test-engine-notice-policy: ALL_OK");
