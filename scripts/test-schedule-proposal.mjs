#!/usr/bin/env node
// The agent can propose a schedule; the user confirms it. Field case
// 2026-09-29: "没五分钟查看小米汽车销量" (每 typed as 没) passed the keyword
// pre-check by; the model understood it but had no tool, and told the user a
// task was registered and a card would appear. None did.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildScheduleProposalToolDefinition } = require("../src/main/mcp/schedule-proposal-tool-definition.js");
const { scheduledDraftFromTurnTools } = require("../src/main/schedule-proposal.js");
const { STATIC_TOOL_DEFINITIONS } = require("../src/main/mcp/tool-broker-registry.js");
const { isSideEffectFreeToolRun } = require("../src/main/tool-semantics.js");

const tool = buildScheduleProposalToolDefinition({});

// 1. The tool validates and only proposes.
const ok = await tool.handler({ title: "小米汽车销量", prompt: "查看小米汽车最新销量", schedule: { type: "interval", every: 5, unit: "minute" } });
assert.equal(ok.ok, true);
assert.deepEqual(ok.proposal.schedule, { type: "interval", every: 5, unit: "minute" });
assert.equal(ok.pendingUserConfirmation, true, "the result tells the model the user still has to confirm");
assert.ok(ok.nextRunAt && ok.scheduleText);
assert.equal((await tool.handler({ title: "x", prompt: "y", schedule: { type: "weekly" } })).error, "INVALID_SCHEDULE");
assert.equal((await tool.handler({ title: "x", prompt: "y", schedule: { type: "once", at: "2020-01-01T09:00:00+08:00" } })).error, "SCHEDULE_NOT_RUNNABLE");
assert.ok(tool.description.includes("ONLY after they confirm"), "the description forbids claiming it is already scheduled");

// 2. It is offered to sessions and marked side-effect free.
assert.ok(STATIC_TOOL_DEFINITIONS.some((item) => item.name === "lily_schedule_propose"), "registered in the tool broker");
assert.equal(isSideEffectFreeToolRun([{ name: "lily_tool_broker_lily_schedule_propose" }]), true,
  "proposing is side-effect free, so a turn that only proposed stays replay-safe");

// 3. The turn's card comes from the tool's structured result (as recorded).
const recorded = (proposal, status = "done") => ({ name: "lily_tool_broker_lily_schedule_propose", status, result: { content: JSON.stringify({ ok: true, proposal }) } });
const draft = scheduledDraftFromTurnTools({
  tools: [recorded({ title: "旧", prompt: "旧的", schedule: { type: "daily", hour: 9, minute: 0 } }), recorded({ title: "小米汽车销量", prompt: "查看最新销量", schedule: { type: "interval", every: 5, unit: "minute" } })],
  sessionId: "s1", projectId: "p1", userText: "没五分钟查看小米汽车销量",
});
assert.equal(draft.status, "pending");
assert.equal(draft.source, "agent_tool");
assert.equal(draft.draft.title, "小米汽车销量", "the last proposal wins");
assert.equal(draft.draft.sessionId, "s1");
assert.ok(draft.draft.nextRunAt && draft.draft.scheduleText);
assert.equal(scheduledDraftFromTurnTools({ tools: [recorded({ title: "x", prompt: "y", schedule: { type: "interval", every: 5, unit: "minute" } }, "error")] }), null, "a failed call proposes nothing");
assert.equal(scheduledDraftFromTurnTools({ tools: [recorded({ title: "x", prompt: "y", schedule: { type: "nope" } })] }), null, "an invalid proposal proposes nothing");
assert.equal(scheduledDraftFromTurnTools({ tools: [{ name: "bash", status: "done", result: { content: "{\"ok\":true,\"proposal\":{}}" } }] }), null, "only the proposal tool counts");

console.log("schedule-proposal: ok");
