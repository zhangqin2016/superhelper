#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { questionCard } from "../src/renderer/modules/turn-question-card.js";

function element(tagName) {
  const classes = new Set();
  const el = {
    tagName,
    type: "",
    className: "",
    dataset: {},
    textContent: "",
    title: "",
    rows: 0,
    placeholder: "",
    value: "",
    children: [],
    listeners: {},
    classList: {
      toggle(name, value) {
        if (value) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name) || el.className.split(/\s+/).includes(name);
      },
    },
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    querySelectorAll(selector) {
      const className = selector.startsWith(".") ? selector.slice(1) : "";
      const found = [];
      const walk = (node) => {
        if (className && node.className?.split(/\s+/).includes(className)) found.push(node);
        for (const child of node.children || []) walk(child);
      };
      walk(this);
      return found;
    },
  };
  return el;
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const responses = [];
const toasts = [];
const deps = {
  translate: (key) => ({
    "turn.question.cardTitle": "Question",
    "question.otherPlaceholder": "Type answer",
    "question.submit": "Submit",
    "common.actionFailed": "Failed",
  }[key] || key),
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
  assistantClient: {
    async respondUserQuestion(sessionId, requestId, answers, summary) {
      responses.push({ sessionId, requestId, answers, summary });
      return { ok: true };
    },
  },
  toast: (message, type) => toasts.push({ message, type }),
};

const immediate = questionCard("session_1", {
  requestId: "q_1",
  questions: [{
    id: "choice",
    question: "Pick one",
    options: [{ label: "A", description: "Alpha" }, { label: "B" }],
  }],
}, deps);
assert.equal(immediate.titleText, "Question");
const optionA = immediate.children[0].children[1].children[0];
assert.equal(optionA.className, "assistant-question-option");
assert.equal(optionA.textContent, "A");
assert.equal(optionA.dataset.questionId, "choice");
assert.equal(optionA.dataset.value, "A");
assert.equal(optionA["aria-pressed"], "false");
assert.equal(optionA.title, "Alpha");
await optionA.listeners.click();
assert.deepEqual(responses.at(-1), {
  sessionId: "session_1",
  requestId: "q_1",
  answers: { choice: "A" },
  summary: "A",
});

const explicit = questionCard("session_1", {
  requestId: "q_2",
  questions: [
    {
      id: "multi",
      question: "Pick many",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      id: "notes",
      question: "Why?",
      options: [],
    },
  ],
}, deps);
const multiButton = explicit.children[0].children[1].children[0];
multiButton.listeners.click();
assert.equal(multiButton.classList.contains("is-selected"), true);
const input = explicit.children[1].children[1];
assert.equal(input.className, "assistant-question-input");
assert.equal(input.placeholder, "Type answer");
input.value = "because";
input.listeners.input();
await explicit.children[2].children[0].action();
assert.deepEqual(responses.at(-1), {
  sessionId: "session_1",
  requestId: "q_2",
  answers: { multi: ["A"], notes: "because" },
  summary: "A\nbecause",
});
assert.deepEqual(toasts, []);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function questionCard"),
  false,
  "turn-view-renderer should delegate question cards to turn-question-card",
);

console.log("turn-question-card: ok");
