#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderProcessGroup } from "../src/renderer/modules/turn-process-group.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    textContent: "",
    open: true,
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    append(...items) {
      for (const item of items) this.appendChild(item);
    },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const group = renderProcessGroup({
  processTools: [{ id: "tool_1" }],
  notices: [{ id: "notice_1" }],
  sealed: true,
  childTools: new Map(),
  entryCtx: { sessionId: "session_1" },
}, {
  processSummary: (tools, notices) => `tools:${tools.length}/notices:${notices.length}`,
  renderGrouped: (body, tools, notices, sealed, childTools, entryCtx) => {
    const marker = document.createElement("div");
    marker.className = "grouped-marker";
    marker.textContent = `${tools[0].id}:${notices[0].id}:${sealed}:${entryCtx.sessionId}:${childTools.size}`;
    body.appendChild(marker);
  },
});

assert.equal(group.className, "assistant-process-group");
assert.equal(group.open, false);
assert.equal(group.children[0].tagName, "summary");
assert.equal(group.children[0].textContent, "tools:1/notices:1");
assert.equal(group.children[1].className, "assistant-process-group-body");
// Folded content is built when first opened, not while nobody can see it.
assert.equal(group.children[1].children.length, 0, "a folded group builds no rows before it is opened");
group.open = true;
for (const fn of group.listeners.toggle || []) fn();
assert.equal(group.children[1].children[0].textContent, "tool_1:notice_1:true:session_1:0");
for (const fn of group.listeners.toggle || []) fn();
assert.equal(group.children[1].children.length, 1, "and builds them once");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("assistant-process-group-body"),
  false,
  "turn-view-renderer should delegate collapsed process group DOM to turn-process-group",
);

// ---------------------------------------------- sealed narration folds with its steps
// A real long turn finished and still showed its running commentary ("批次 9
// 完成，进入批次 10…") stacked above an answer that already covered it — the
// assistant appeared to keep talking after it was done.
{
  const { prepareProcessRenderView } = await import("../src/renderer/modules/turn-process-render-view.js");
  const { renderProcessTimeline } = await import("../src/renderer/modules/turn-process-timeline.js");
  const turn = {
    final: { type: "turn.completed" },
    timeline: [
      { kind: "text", id: "text_1", text: "批次 9 代码部分完成。跑全量确认。", status: "done" },
      { kind: "tool", id: "t1", name: "bash", status: "done" },
      { kind: "text", id: "text_2", text: "\n\n\n", status: "done" }, // archived before separators stopped opening blocks
      { kind: "tool", id: "t2", name: "read", status: "done" },
      { kind: "text", id: "text_3", text: "批次 10：文档三态已就位。", status: "done" },
      { kind: "tool", id: "t3", name: "edit", status: "done" },
      { kind: "text", id: "text_4", text: "全部按计划完成。", status: "done" },
    ],
  };
  const renderInto = (view) => renderProcessTimeline(view, {
    sealed: true,
    renderEntry: (entry) => ({ tagName: "entry", textContent: `${entry.kind}:${entry.id}`, children: [] }),
    renderGroup: ({ processTools, narration }) => ({
      tagName: "group",
      textContent: `group:${narration.map((e) => e.id).join(",")}|${processTools.map((e) => e.id).join(",")}`,
      children: [],
    }),
  }).children.map((node) => node.textContent);

  const sealed = prepareProcessRenderView(turn, true);
  assert.equal(sealed.foldNarration, true);
  assert.deepEqual(renderInto(sealed), ["group:text_1,text_3|t1,t2,t3"],
    "sealed: narration folds into the step group, in order; the blank block and the answer are in neither");

  const live = prepareProcessRenderView({ ...turn, final: null }, false);
  assert.equal(live.foldNarration, false, "while the turn runs, narration is how the user follows it");
  assert.ok(renderInto(live).includes("text:text_1"), "and it stays in place");

  const noSteps = prepareProcessRenderView({
    final: { type: "turn.completed" },
    timeline: [
      { kind: "text", id: "text_1", text: "先列计划。", status: "done" },
      { kind: "tool", id: "todo_1", name: "todowrite", status: "done" },
      { kind: "tool", id: "todo_2", name: "todowrite", status: "done" },
      { kind: "text", id: "text_2", text: "答案。", status: "done" },
    ],
  }, true);
  assert.equal(noSteps.foldNarration, false, "with no step group to fold into, narration is never hidden in an empty one");

  const folded = renderProcessGroup({
    processTools: [{ id: "t1" }],
    narration: [{ kind: "text", id: "text_1" }, { kind: "text", id: "text_3" }],
    sealed: true,
  }, {
    processSummary: () => "summary",
    renderGrouped: (container) => container.appendChild({ textContent: "steps" }),
    renderNarration: (entry) => ({ textContent: entry.id }),
  });
  folded.__ensureContent();
  const body = folded.children[1];
  assert.deepEqual(body.children.map((node) => node.textContent), ["text_1", "text_3", "steps"],
    "inside the group the narration leads, as the outline of the steps below it");
}

console.log("turn-process-group: ok");
