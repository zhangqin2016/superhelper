#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hookCard,
  permissionCard,
  planApprovalCard,
} from "../src/renderer/modules/turn-action-prompt-cards.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    textContent: "",
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const calls = [];
const deps = {
  translate: (key) => ({
    "permission.approveActionTitle": "Approve action",
    "permission.allow": "Allow",
    "permission.deny": "Deny",
    "hook.approve": "Approve",
    "hook.reject": "Reject",
    "plan.keepPlanningMessage": "Keep planning",
    "plan.truncated": "Truncated",
    "common.actionFailed": "Failed",
  }[key] || key),
  permissionLabel: () => "Permission detail",
  createCard: (title, detail) => {
    const card = element("card");
    card.titleText = title;
    card.detailText = detail;
    return card;
  },
  createActions: () => {
    const row = element("actions");
    row.className = "actions";
    return row;
  },
  createButton: (label, action) => {
    const btn = element("button");
    btn.textContent = label;
    btn.action = action;
    return btn;
  },
  renderMarkdown: (node, text) => {
    calls.push(["markdown", text]);
    node.textContent = text;
  },
  assistantClient: {
    respondPermission: (...args) => {
      calls.push(["permission", ...args]);
      return { ok: true };
    },
    respondHook: (...args) => {
      calls.push(["hook", ...args]);
      return { ok: true };
    },
  },
};

const permission = permissionCard("session_1", {
  requestId: "perm_1",
  title: "Run command",
}, deps);
assert.equal(permission.titleText, "Approve action");
assert.equal(permission.detailText, "Permission detail");
assert.equal(permission.children[0].className, "actions");
assert.ok(permission.children[0].children.length >= 2);
await permission.children[0].children[0].action();
assert.deepEqual(calls.at(-1), ["permission", "session_1", "perm_1", true, undefined]);

const hook = hookCard("session_1", { requestId: "hook_1", title: "Hook" }, deps);
await hook.children[0].children[0].action();
assert.deepEqual(calls.at(-1), ["hook", "session_1", "hook_1", true]);

const plan = planApprovalCard("session_1", {
  requestId: "plan_1",
  title: "Plan",
  toolName: "ExitPlanMode",
  planPreview: "Step 1\nStep 2",
  planPreviewTruncated: true,
}, deps);
assert.equal(plan.children[0].className, "assistant-plan-body markdown-body");
assert.deepEqual(calls.find((call) => call[0] === "markdown"), ["markdown", "Step 1\nStep 2"]);
assert.equal(plan.children[0].children[0].className, "assistant-plan-truncated");
assert.equal(plan.children[0].children[0].textContent, "Truncated");
assert.ok(plan.children[1].children.length >= 2, "plan approvals should keep action buttons");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
for (const fn of ["function permissionCard", "function planApprovalCard", "function hookCard"]) {
  assert.equal(rendererSource.includes(fn), false, `turn-view-renderer should delegate ${fn}`);
}

console.log("turn-action-prompt-cards: ok");
