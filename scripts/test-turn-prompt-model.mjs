#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildPromptViewModel,
  hookActionViews,
  hookResponseForAction,
  planApprovalViewForItem,
  permissionActionViews,
  permissionResponseForAction,
  planApprovalActionViews,
  promptCardViewForItem,
  promptKindForItem,
  promptRendererKeyForKind,
} from "../src/renderer/modules/turn-prompt-model.js";
import { readFileSync } from "node:fs";

assert.equal(
  promptKindForItem({ requestId: "q1", questions: [] }),
  "question",
  "items with questions should render as question prompts",
);
assert.equal(
  promptKindForItem({ requestId: "h1", hookName: "before_command" }),
  "hook",
  "hook requests should render as hook prompts",
);
assert.equal(
  promptKindForItem({ requestId: "p1", toolName: "ExitPlanMode" }),
  "plan",
  "ExitPlanMode permission should render as the dedicated plan approval prompt",
);
assert.equal(
  promptKindForItem({ requestId: "p2", toolName: "bash" }),
  "permission",
  "ordinary tool permission should render as a permission prompt",
);
assert.equal(
  promptKindForItem(null),
  "permission",
  "unknown prompt items should fail open to the existing permission prompt path",
);
assert.equal(promptRendererKeyForKind("question"), "question");
assert.equal(promptRendererKeyForKind("hook"), "hook");
assert.equal(promptRendererKeyForKind("plan"), "plan");
assert.equal(promptRendererKeyForKind("permission"), "permission");
assert.equal(
  promptRendererKeyForKind("unknown"),
  "permission",
  "unknown prompt renderer kind should fail open to the permission prompt path",
);

assert.deepEqual(
  planApprovalViewForItem({ planPreview: "  short plan  ", planPreviewTruncated: true }),
  { planText: "short plan", truncated: true },
  "plan approval view should prefer trimmed planPreview and preserve truncation state",
);
assert.deepEqual(
  planApprovalViewForItem({ input: { plan: " fallback plan " } }),
  { planText: "fallback plan", truncated: false },
  "plan approval view should fall back to input.plan when planPreview is absent",
);
assert.deepEqual(
  permissionActionViews(),
  [
    { labelKey: "permission.approve", response: { approved: true } },
    { labelKey: "permission.deny", response: { approved: false } },
    { labelKey: "permission.approveRememberShort", response: { approved: true, options: { remember: true } } },
  ],
  "permission actions should preserve approve, deny, and approve-remember semantics",
);
assert.deepEqual(
  planApprovalActionViews("keep planning"),
  [
    { labelKey: "plan.approve", response: { approved: true } },
    { labelKey: "plan.keepPlanning", response: { approved: false, options: { message: "keep planning" } } },
  ],
  "plan actions should preserve the keep-planning feedback message",
);
assert.deepEqual(
  hookActionViews(),
  [
    { labelKey: "hook.allowTool", response: { approved: true } },
    { labelKey: "hook.denyTool", response: { approved: false } },
  ],
  "hook actions should preserve allow and deny semantics",
);
assert.deepEqual(
  permissionResponseForAction({ response: { approved: true, options: { remember: true } } }),
  { approved: true, options: { remember: true } },
  "permission response should preserve approved flag and options",
);
assert.deepEqual(
  permissionResponseForAction({ response: { approved: false } }),
  { approved: false, options: undefined },
  "permission response should preserve denied actions without inventing options",
);
assert.deepEqual(
  hookResponseForAction({ response: { approved: true } }),
  { approved: true },
  "hook response should preserve approved flag",
);
const translate = (key) => ({
  "permission.approveActionTitle": "Approve action",
  "turn.hook.confirmTitle": "Confirm hook",
  "hook.title": "Hook",
  "plan.readyTitle": "Plan ready",
  "turn.question.cardTitle": "Question",
  "subagent.questionCardTitle": "Subagent question",
}[key] || key);
assert.deepEqual(
  promptCardViewForItem({ toolName: "bash" }, { translate, permissionLabel: () => "Run bash" }),
  { title: "Approve action", detail: "Run bash" },
  "permission prompt card view should preserve the permission label detail",
);
assert.deepEqual(
  promptCardViewForItem({ hookName: "" }, { translate, permissionLabel: () => "" }),
  { title: "Confirm hook", detail: "Hook" },
  "hook prompt card view should fall back to the generic hook title",
);
assert.deepEqual(
  promptCardViewForItem({ toolName: "ExitPlanMode" }, { translate, permissionLabel: () => "" }),
  { title: "Plan ready", detail: "" },
  "plan prompt card view should use the dedicated plan title",
);
assert.deepEqual(
  promptCardViewForItem({ questions: [], subagent: { sessionId: "sub_1" } }, { translate, permissionLabel: () => "" }),
  { title: "Subagent question", detail: "" },
  "subagent questions should keep the subagent-specific title",
);
assert.deepEqual(
  promptCardViewForItem({ questions: [] }, { translate, permissionLabel: () => "" }),
  { title: "Question", detail: "" },
  "regular questions should keep the normal question title",
);

const promptTurn = buildPromptViewModel({
  permissions: new Map([
    ["perm_1", { requestId: "perm_1", toolName: "bash" }],
  ]),
  questions: new Map([
    ["question_1", { requestId: "question_1", questions: [{ id: "answer" }] }],
  ]),
  hooks: new Map([
    ["hook_1", { requestId: "hook_1", hookName: "before_command" }],
  ]),
});
assert.deepEqual(
  promptTurn.entries.map((item) => item.requestId),
  ["perm_1", "question_1", "hook_1"],
  "prompt view model should preserve permission/question/hook order",
);
assert.equal(promptTurn.signature, "p:perm_1|q:question_1|h:hook_1");
assert.deepEqual(promptTurn.activeQuestionRequestIds, new Set(["question_1"]));
assert.equal(promptTurn.visible, true);
assert.deepEqual(
  buildPromptViewModel({ permissions: [{ requestId: "perm_array" }] }).entries.map((item) => item.requestId),
  ["perm_array"],
  "prompt view model should accept arrays as well as maps",
);

const turnViewModelSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-model.js", import.meta.url),
  "utf8",
);
assert.match(turnViewModelSource, /from "\.\/turn-prompt-model\.js"/);
assert.doesNotMatch(turnViewModelSource, /function buildPromptViewModel\s*\(/);
assert.doesNotMatch(turnViewModelSource, /function mapValues\s*\(/);

console.log("turn-prompt-model: ok");
