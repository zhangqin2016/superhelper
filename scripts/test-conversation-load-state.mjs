import assert from "node:assert/strict";
import { beginConversationLoad, finishConversationLoad, conversationLoadStatus } from "../src/renderer/modules/conversation-load-state.js";

assert.equal(conversationLoadStatus("new"), "ready");
const a = beginConversationLoad("a");
assert.equal(conversationLoadStatus("a"), "loading");
const b = beginConversationLoad("b");
assert.equal(finishConversationLoad("b", b, false), true);
assert.equal(conversationLoadStatus("b"), "error");
assert.equal(conversationLoadStatus("a"), "loading");
const newer = beginConversationLoad("a");
assert.equal(finishConversationLoad("a", a, true), false);
assert.equal(conversationLoadStatus("a"), "loading");
assert.equal(finishConversationLoad("a", newer, true), true);
assert.equal(conversationLoadStatus("a"), "ready");
const retry = beginConversationLoad("b");
finishConversationLoad("b", retry, true);
assert.equal(conversationLoadStatus("b"), "ready");
console.log("conversation load state: ownership, errors and retry passed");

const { syncWorkbenchEmptyState } = await import("../src/renderer/modules/workbench-empty.js");
function element() {
  return {
    children: [], className: "", dataset: {}, setAttribute() {}, addEventListener() {},
    get classList() { return { contains: value => this.className.split(" ").includes(value) }; },
    append(...items) { for (const item of items) { this.children.push(item); item.parent = this; } },
    appendChild(item) { this.append(item); },
    querySelector(selector) { return this.children.find(child => child.classList.contains(selector.slice(1))) || null; },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
    closest() { return { dataset: { sessionId: "native" } }; },
  };
}
globalThis.document = { createElement: element };
const list = element();
const request = beginConversationLoad("native");
syncWorkbenchEmptyState(list);
assert.equal(list.querySelector(".workbench-empty"), null, "loading is not an empty conversation");
assert.ok(list.querySelector(".conversation-load-status"));
finishConversationLoad("native", request, false);
syncWorkbenchEmptyState(list);
assert.equal(list.querySelector(".workbench-empty"), null, "failure cannot pretend to have zero history");
const recovered = beginConversationLoad("native");
finishConversationLoad("native", recovered, true);
syncWorkbenchEmptyState(list);
assert.ok(list.querySelector(".workbench-empty"), "confirmed empty chat retains starters");
const content = element(); content.className = "assistant-turn-article";
list.append(content);
beginConversationLoad("native");
syncWorkbenchEmptyState(list);
assert.equal(list.querySelector(".workbench-empty"), null);
assert.equal(list.querySelector(".conversation-load-status"), null, "refresh keeps cached content visible");
assert.ok(list.children.includes(content));
console.log("conversation loading DOM: pending/error/empty/cached states passed");
