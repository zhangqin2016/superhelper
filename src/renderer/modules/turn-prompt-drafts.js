const questionDrafts = new Map();

export function questionDraftKey(sessionId, requestId) {
  return `${sessionId || ""}:${requestId || ""}`;
}

export function getQuestionDraft(sessionId, requestId) {
  const key = questionDraftKey(sessionId, requestId);
  if (!questionDrafts.has(key)) {
    questionDrafts.set(key, {
      selections: new Map(),
      text: new Map(),
    });
  }
  return questionDrafts.get(key);
}

export function pruneQuestionDrafts(sessionId, activeRequestIds) {
  const prefix = `${sessionId || ""}:`;
  for (const key of questionDrafts.keys()) {
    if (!key.startsWith(prefix)) continue;
    const requestId = key.slice(prefix.length);
    if (!activeRequestIds.has(requestId)) questionDrafts.delete(key);
  }
}

export function setQuestionSelection(draft, questionId, value, { multiSelect }) {
  const current = new Set(draft.selections.get(questionId) || []);
  if (multiSelect) {
    if (current.has(value)) current.delete(value);
    else current.add(value);
  } else {
    current.clear();
    current.add(value);
  }
  if (current.size) draft.selections.set(questionId, current);
  else draft.selections.delete(questionId);
  return current;
}

export function questionAnswerId(question = {}) {
  return question.id || question.question || "answer";
}

export function questionRequiresExplicitSubmit(questions = []) {
  return questions.length > 1 || questions.some((question) => Boolean(question.multiSelect));
}

export function questionOptions(question = {}) {
  return Array.isArray(question.options) ? question.options.filter((option) => option?.label) : [];
}

export function questionViewForQuestion(question = {}, { translate }) {
  const options = questionOptions(question);
  return {
    questionId: questionAnswerId(question),
    label: question.question || translate("question.freeAnswerPrompt"),
    options,
    usesFreeText: options.length === 0,
  };
}

export function questionCardViewForQuestions(questions = [], { translate }) {
  const questionViews = questions.map((question) => questionViewForQuestion(question, { translate }));
  const requiresExplicitSubmit = questionRequiresExplicitSubmit(questions);
  return {
    requiresExplicitSubmit,
    needsSubmit: requiresExplicitSubmit || questionViews.some((question) => question.usesFreeText),
    questions: questionViews,
  };
}

export function questionOptionViewForOption(option = {}, questionView, draft) {
  const selectedValues = draft.selections.get(questionView.questionId) || new Set();
  const selected = selectedValues.has(option.label);
  return {
    label: option.label,
    description: option.description || "",
    questionId: questionView.questionId,
    value: option.label,
    selected,
    className: `assistant-question-option${selected ? " is-selected" : ""}`,
    ariaPressed: selected ? "true" : "false",
  };
}

export function questionInputViewForQuestion(questionView, draft, { placeholder }) {
  return {
    questionId: questionView.questionId,
    value: draft.text.get(questionView.questionId) || "",
    placeholder,
    rows: 2,
  };
}

export function questionImmediateAnswerForOption(optionView) {
  return {
    answers: { [optionView.questionId]: optionView.value },
    summary: optionView.value,
  };
}

export function questionSubmitActionView() {
  return { labelKey: "question.submit" };
}

export function collectQuestionAnswers(questions = [], draft, inputs = []) {
  const answers = {};
  for (const question of questions) {
    const questionId = questionAnswerId(question);
    const selected = Array.from(draft.selections.get(questionId) || []);
    if (selected.length) {
      answers[questionId] = question.multiSelect ? selected : selected[0];
    }
  }
  for (const input of inputs) {
    const questionId = input.dataset.questionId;
    const value = input.value;
    draft.text.set(questionId, value);
    answers[questionId] = value;
  }
  return {
    answers,
    summary: Object.values(answers).flat().filter(Boolean).join("\n"),
  };
}

export function questionSubmitAnswerForInputs(questions = [], draft, inputs = []) {
  return collectQuestionAnswers(questions, draft, inputs);
}

export function questionResponseForAnswer(answer = {}) {
  return {
    answers: answer.answers || {},
    summary: answer.summary || "",
  };
}

export function recordQuestionInputDraft(draft, input) {
  const questionId = input.dataset.questionId;
  const value = input.value;
  draft.text.set(questionId, value);
  return { questionId, value };
}

export function recordQuestionOptionSelection(draft, optionView, { multiSelect }) {
  const selectedValues = setQuestionSelection(draft, optionView.questionId, optionView.value, { multiSelect });
  return {
    selectedValues,
    selectionState: {
      optionLabel: optionView.value,
      selectedValues,
      multiSelect,
    },
  };
}

export function applyQuestionOptionSelectionState({
  button,
  optionsEl,
  optionLabel,
  selectedValues,
  multiSelect = false,
}) {
  if (multiSelect) {
    const isSelected = selectedValues.has(optionLabel);
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", isSelected ? "true" : "false");
    return;
  }
  for (const sibling of optionsEl.querySelectorAll(".assistant-question-option")) {
    const isSelected = sibling.dataset.value === optionLabel;
    sibling.classList.toggle("is-selected", isSelected);
    sibling.setAttribute("aria-pressed", isSelected ? "true" : "false");
  }
}
