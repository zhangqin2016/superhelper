#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  getQuestionDraft,
  collectQuestionAnswers,
  pruneQuestionDrafts,
  applyQuestionOptionSelectionState,
  questionCardViewForQuestions,
  questionRequiresExplicitSubmit,
  questionDraftKey,
  questionInputViewForQuestion,
  questionImmediateAnswerForOption,
  questionOptionViewForOption,
  questionOptions,
  recordQuestionOptionSelection,
  recordQuestionInputDraft,
  questionSubmitActionView,
  questionSubmitAnswerForInputs,
  questionResponseForAnswer,
  questionViewForQuestion,
  setQuestionSelection,
} from "../src/renderer/modules/turn-prompt-drafts.js";

assert.equal(questionDraftKey("session_1", "request_1"), "session_1:request_1");

const draft = getQuestionDraft("session_1", "request_1");
assert.equal(getQuestionDraft("session_1", "request_1"), draft, "drafts should be stable per session/request");
assert.equal(draft.selections instanceof Map, true);
assert.equal(draft.text instanceof Map, true);

let selected = setQuestionSelection(draft, "q1", "A", { multiSelect: true });
assert.deepEqual([...selected], ["A"]);
selected = setQuestionSelection(draft, "q1", "B", { multiSelect: true });
assert.deepEqual([...selected], ["A", "B"]);
selected = setQuestionSelection(draft, "q1", "A", { multiSelect: true });
assert.deepEqual([...selected], ["B"], "multi-select should toggle existing values off");

selected = setQuestionSelection(draft, "q2", "A", { multiSelect: false });
assert.deepEqual([...selected], ["A"]);
selected = setQuestionSelection(draft, "q2", "B", { multiSelect: false });
assert.deepEqual([...selected], ["B"], "single-select should replace prior value");

const stale = getQuestionDraft("session_1", "stale");
stale.text.set("answer", "remove me");
const otherSession = getQuestionDraft("session_2", "stale");
otherSession.text.set("answer", "keep me");
pruneQuestionDrafts("session_1", new Set(["request_1"]));
assert.equal(getQuestionDraft("session_1", "request_1"), draft, "active draft should survive pruning");
assert.equal(getQuestionDraft("session_2", "stale").text.get("answer"), "keep me", "other sessions should not be pruned");
assert.equal(getQuestionDraft("session_1", "stale").text.get("answer"), undefined, "inactive same-session draft should be pruned");

const answerDraft = {
  selections: new Map([
    ["single", new Set(["A"])],
    ["multi", new Set(["B", "C"])],
  ]),
  text: new Map(),
};
const collected = collectQuestionAnswers([
  { id: "single" },
  { id: "multi", multiSelect: true },
  { id: "empty" },
], answerDraft, [
  { dataset: { questionId: "free" }, value: "typed answer" },
  { dataset: { questionId: "blank" }, value: "" },
]);
assert.deepEqual(
  collected.answers,
  { single: "A", multi: ["B", "C"], free: "typed answer", blank: "" },
  "question answers should preserve single-select, multi-select, and free-text inputs",
);
assert.equal(
  collected.summary,
  "A\nB\nC\ntyped answer",
  "question answer summary should flatten selected and typed non-empty values for the transcript",
);
assert.equal(answerDraft.text.get("free"), "typed answer", "free-text answers should be stored back into the draft");
assert.equal(answerDraft.text.get("blank"), "", "blank free-text answers should still update draft state");
assert.equal(
  questionRequiresExplicitSubmit([{ id: "single", options: [{ label: "A" }] }]),
  false,
  "one single-select question should preserve immediate-answer behavior",
);
assert.equal(
  questionRequiresExplicitSubmit([
    { id: "one", options: [{ label: "A" }] },
    { id: "two", options: [{ label: "B" }] },
  ]),
  true,
  "multiple questions should require an explicit submit so answers are sent together",
);
assert.equal(
  questionRequiresExplicitSubmit([{ id: "multi", multiSelect: true, options: [{ label: "A" }] }]),
  true,
  "multi-select questions should require an explicit submit",
);
assert.deepEqual(
  questionOptions({ options: [{ label: "A" }, { label: "" }, null, { description: "missing label" }] }),
  [{ label: "A" }],
  "question options should keep only answerable labelled options",
);
assert.deepEqual(questionOptions({ options: null }), [], "non-array question options should normalize to an empty list");
const translate = (key) => ({ "question.freeAnswerPrompt": "Answer" }[key] || key);
assert.deepEqual(
  questionViewForQuestion(
    { id: "choice", question: "Pick one", options: [{ label: "A" }, { label: "" }] },
    { translate },
  ),
  {
    questionId: "choice",
    label: "Pick one",
    options: [{ label: "A" }],
    usesFreeText: false,
  },
  "question view should preserve id, label, and answerable options",
);
assert.deepEqual(
  questionViewForQuestion({}, { translate }),
  {
    questionId: "answer",
    label: "Answer",
    options: [],
    usesFreeText: true,
  },
  "free-text question view should use fallback id and prompt label",
);
assert.deepEqual(
  questionOptionViewForOption(
    { label: "A", description: "Alpha" },
    { questionId: "choice" },
    { selections: new Map([["choice", new Set(["A"])]]) },
  ),
  {
    label: "A",
    description: "Alpha",
    questionId: "choice",
    value: "A",
    selected: true,
    className: "assistant-question-option is-selected",
    ariaPressed: "true",
  },
  "selected question option view should expose DOM-ready state",
);
assert.deepEqual(
  questionOptionViewForOption(
    { label: "B" },
    { questionId: "choice" },
    { selections: new Map([["choice", new Set(["A"])]]) },
  ),
  {
    label: "B",
    description: "",
    questionId: "choice",
    value: "B",
    selected: false,
    className: "assistant-question-option",
    ariaPressed: "false",
  },
  "unselected question option view should expose an unpressed state",
);
assert.deepEqual(
  questionInputViewForQuestion(
    { questionId: "free" },
    { text: new Map([["free", "draft text"]]) },
    { placeholder: "Other" },
  ),
  {
    questionId: "free",
    value: "draft text",
    placeholder: "Other",
    rows: 2,
  },
  "question input view should preserve draft text and textarea defaults",
);
assert.deepEqual(
  questionCardViewForQuestions([
    { id: "single", question: "Pick", options: [{ label: "A" }] },
  ], { translate }),
  {
    requiresExplicitSubmit: false,
    needsSubmit: false,
    questions: [
      {
        questionId: "single",
        label: "Pick",
        options: [{ label: "A" }],
        usesFreeText: false,
      },
    ],
  },
  "single single-select question should not need a submit button",
);
assert.deepEqual(
  questionCardViewForQuestions([
    { id: "multi", question: "Pick many", multiSelect: true, options: [{ label: "A" }] },
    { id: "free", question: "Explain" },
  ], { translate }),
  {
    requiresExplicitSubmit: true,
    needsSubmit: true,
    questions: [
      {
        questionId: "multi",
        label: "Pick many",
        options: [{ label: "A" }],
        usesFreeText: false,
      },
      {
        questionId: "free",
        label: "Explain",
        options: [],
        usesFreeText: true,
      },
    ],
  },
  "multi-select or free-text question cards should need explicit submit",
);
assert.deepEqual(
  questionImmediateAnswerForOption({ questionId: "choice", value: "A" }),
  { answers: { choice: "A" }, summary: "A" },
  "immediate option answer should preserve the same answers/summary contract as submit",
);
assert.deepEqual(
  questionSubmitActionView(),
  { labelKey: "question.submit" },
  "question submit action should keep the submit label key in the prompt model",
);
const submitDraft = {
  selections: new Map([["multi", new Set(["A", "B"])]]),
  text: new Map(),
};
assert.deepEqual(
  questionSubmitAnswerForInputs(
    [{ id: "multi", multiSelect: true }, { id: "free" }],
    submitDraft,
    [{ dataset: { questionId: "free" }, value: "details" }],
  ),
  { answers: { multi: ["A", "B"], free: "details" }, summary: "A\nB\ndetails" },
  "question submit answer should preserve structured answers and transcript summary",
);
assert.deepEqual(
  questionResponseForAnswer({ answers: { choice: "A" }, summary: "A" }),
  { answers: { choice: "A" }, summary: "A" },
  "question response should preserve answers and summary for IPC",
);
const inputDraft = { text: new Map() };
assert.deepEqual(
  recordQuestionInputDraft(inputDraft, { dataset: { questionId: "free" }, value: "typed" }),
  { questionId: "free", value: "typed" },
  "recording question input should report the updated draft entry",
);
assert.equal(inputDraft.text.get("free"), "typed", "recording question input should persist typed text in the draft");
const selectionDraft = { selections: new Map() };
const selectionResult = recordQuestionOptionSelection(selectionDraft, {
  questionId: "choice",
  value: "A",
}, { multiSelect: true });
assert.deepEqual([...selectionResult.selectedValues], ["A"]);
assert.deepEqual(
  selectionResult.selectionState,
  { optionLabel: "A", selectedValues: selectionResult.selectedValues, multiSelect: true },
  "recording option selection should return DOM-sync state",
);

function optionButton(value) {
  const classes = new Set();
  return {
    dataset: { value },
    attributes: {},
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

const multiButton = optionButton("A");
applyQuestionOptionSelectionState({
  button: multiButton,
  optionsEl: null,
  optionLabel: "A",
  selectedValues: new Set(["A"]),
  multiSelect: true,
});
assert.equal(multiButton.classList.contains("is-selected"), true, "multi-select should mark the clicked selected option");
assert.equal(multiButton.attributes["aria-pressed"], "true");

const siblingA = optionButton("A");
const siblingB = optionButton("B");
const optionsEl = {
  querySelectorAll(selector) {
    assert.equal(selector, ".assistant-question-option");
    return [siblingA, siblingB];
  },
};
applyQuestionOptionSelectionState({
  button: siblingB,
  optionsEl,
  optionLabel: "B",
  selectedValues: new Set(["B"]),
  multiSelect: false,
});
assert.equal(siblingA.classList.contains("is-selected"), false, "single-select should clear sibling options");
assert.equal(siblingA.attributes["aria-pressed"], "false");
assert.equal(siblingB.classList.contains("is-selected"), true, "single-select should select the clicked option");
assert.equal(siblingB.attributes["aria-pressed"], "true");

console.log("turn-prompt-drafts: ok");
