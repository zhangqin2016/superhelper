#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  activityFromEngineNotice,
  activityFromProcessPayload,
  isInternalActivityLabel,
  isMeaningfulActivityLabel,
  isTokenCountDetail,
  setActivityLabel,
} from "../src/renderer/modules/turn-activity-policy.js";
import {
  activityFromProcessPayload as compatActivityFromProcessPayload,
  isMeaningfulActivityLabel as compatIsMeaningfulActivityLabel,
} from "../src/renderer/modules/turn-timeline.js";

assert.equal(isTokenCountDetail("44 tokens"), true);
assert.equal(isTokenCountDetail("1.5k tokens"), true);
assert.equal(isTokenCountDetail("Uploading 42%"), false);
assert.equal(isInternalActivityLabel("system_notice"), true);
assert.equal(isInternalActivityLabel("assistant text"), true);
assert.equal(isInternalActivityLabel("reading files"), false);
assert.equal(isMeaningfulActivityLabel("Writing chapter 41"), true);
assert.equal(isMeaningfulActivityLabel("requesting"), false);
assert.equal(isMeaningfulActivityLabel("44 tokens"), false);
assert.equal(compatIsMeaningfulActivityLabel("Writing chapter 41"), true);

const statusPayload = {
  rawSubtype: "status",
  event: { status: "Reading recent chapters" },
  actions: [],
};
assert.equal(activityFromProcessPayload(statusPayload), "Reading recent chapters");
assert.equal(compatActivityFromProcessPayload(statusPayload), "Reading recent chapters");
assert.equal(activityFromProcessPayload({ rawSubtype: "status", event: { status: "requesting" } }), null);
assert.equal(activityFromProcessPayload({
  rawSubtype: "task_started",
  summary: "system_notice",
  actions: [{ notice: { code: "taskStarted", detail: "正在写第 90 章" } }],
  event: { type: "system", subtype: "task_started" },
}), null);
assert.equal(activityFromProcessPayload({
  actions: [{ notice: { code: "apiRetry", detail: "Retrying request" } }],
}), "Retrying request");

assert.equal(activityFromEngineNotice({ code: "taskProgress", detail: "Writing chapter 41" }), null);
assert.equal(activityFromEngineNotice({ code: "thinkingProgress", detail: "44 tokens" }), null);
assert.equal(activityFromEngineNotice({ code: "apiRetry", detail: "Retrying request" }), "Retrying request");
assert.equal(activityFromEngineNotice({ level: "progress", detail: "Uploading" }), null);

const target = { activityLabel: null };
setActivityLabel(target, " system_notice ");
assert.equal(target.activityLabel, null);
setActivityLabel(target, " Writing chapter 41 ");
assert.equal(target.activityLabel, "Writing chapter 41");
setActivityLabel(target, "Writing chapter 41");
assert.equal(target.activityLabel, "Writing chapter 41");

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-activity-policy\.js"/);
assert.doesNotMatch(timelineSource, /const GENERIC_STATUS\s*=/);
assert.doesNotMatch(timelineSource, /function isMeaningfulActivityLabel\s*\(/);
assert.doesNotMatch(timelineSource, /function activityFromProcessPayload\s*\(/);

console.log("turn-activity-policy: ok");
