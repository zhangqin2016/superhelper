import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";
import {
  actionButton,
  actionRow,
  promptCard,
} from "./turn-prompt-ui.js";
import { promptCardViewForItem } from "./turn-prompt-model.js";
import { permissionLabelForView } from "./turn-view-status.js";
import {
  applyQuestionOptionSelectionState,
  getQuestionDraft,
  questionCardViewForQuestions,
  questionImmediateAnswerForOption,
  questionInputViewForQuestion,
  questionOptionViewForOption,
  questionResponseForAnswer,
  questionSubmitActionView,
  questionSubmitAnswerForInputs,
  recordQuestionInputDraft,
  recordQuestionOptionSelection,
} from "./turn-prompt-drafts.js";

function defaultButton(label, action, translate = t) {
  return actionButton(label, action, {
    showToast,
    failureText: translate("common.actionFailed"),
  });
}

export function questionCard(sessionId, item, deps = {}) {
  const fullDeps = normalizeDeps(deps);
  const view = promptCardViewForItem(item, {
    translate: fullDeps.translate,
    permissionLabel: fullDeps.permissionLabel,
  });
  const card = fullDeps.createCard(view.title, view.detail);
  const draft = fullDeps.getDraft(sessionId, item.requestId);
  const questions = item.questions || [];
  const questionCardView = questionCardViewForQuestions(questions, { translate: fullDeps.translate });
  for (const [index, question] of questions.entries()) {
    const questionView = questionCardView.questions[index];
    const block = document.createElement("div");
    block.className = "assistant-question-block";
    const label = document.createElement("label");
    label.className = "assistant-question-label";
    label.textContent = questionView.label;
    block.appendChild(label);

    const options = questionView.options;
    if (options.length) {
      const optionsEl = document.createElement("div");
      optionsEl.className = "assistant-question-options";
      for (const option of options) {
        const optionView = questionOptionViewForOption(option, questionView, draft);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = optionView.className;
        btn.textContent = optionView.label;
        btn.dataset.questionId = optionView.questionId;
        btn.dataset.value = optionView.value;
        btn.setAttribute("aria-pressed", optionView.ariaPressed);
        if (optionView.description) btn.title = optionView.description;
        if (questionCardView.requiresExplicitSubmit) {
          btn.addEventListener("click", () => {
            const selection = recordQuestionOptionSelection(draft, optionView, {
              multiSelect: Boolean(question.multiSelect),
            });
            applyQuestionOptionSelectionState({
              button: btn,
              optionsEl,
              ...selection.selectionState,
            });
          });
        } else {
          btn.addEventListener("click", async () => {
            try {
              const response = questionResponseForAnswer(questionImmediateAnswerForOption(optionView));
              const result = await fullDeps.assistantClient.respondUserQuestion(
                sessionId,
                item.requestId,
                response.answers,
                response.summary,
              );
              if (!result?.ok) fullDeps.toast(result?.detail || result?.error || fullDeps.translate("common.actionFailed"), "warning");
            } catch (err) {
              fullDeps.toast(err?.message || fullDeps.translate("common.actionFailed"), "error");
            }
          });
        }
        optionsEl.appendChild(btn);
      }
      block.appendChild(optionsEl);
    } else {
      const inputView = questionInputViewForQuestion(questionView, draft, {
        placeholder: fullDeps.translate("question.otherPlaceholder"),
      });
      const input = document.createElement("textarea");
      input.className = "assistant-question-input";
      input.rows = inputView.rows;
      input.placeholder = inputView.placeholder;
      input.dataset.questionId = inputView.questionId;
      input.value = inputView.value;
      input.addEventListener("input", () => {
        recordQuestionInputDraft(draft, input);
      });
      block.appendChild(input);
    }
    card.appendChild(block);
  }
  if (questionCardView.needsSubmit) {
    const actions = fullDeps.createActions();
    const submitAction = questionSubmitActionView();
    actions.appendChild(fullDeps.createButton(fullDeps.translate(submitAction.labelKey), async () => {
      const response = questionResponseForAnswer(
        questionSubmitAnswerForInputs(
          questions,
          draft,
          card.querySelectorAll(".assistant-question-input"),
        ),
      );
      const result = await fullDeps.assistantClient.respondUserQuestion(
        sessionId,
        item.requestId,
        response.answers,
        response.summary,
      );
      if (!result?.ok) fullDeps.toast(result?.detail || result?.error || fullDeps.translate("common.actionFailed"), "warning");
      return result;
    }));
    card.appendChild(actions);
  }
  return card;
}

function normalizeDeps(deps) {
  const translate = deps.translate || t;
  return {
    translate,
    permissionLabel: deps.permissionLabel || ((item) => permissionLabelForView(item, translate)),
    createCard: deps.createCard || promptCard,
    createActions: deps.createActions || actionRow,
    createButton: deps.createButton || ((label, action) => defaultButton(label, action, translate)),
    getDraft: deps.getDraft || getQuestionDraft,
    assistantClient: deps.assistantClient || window.assistantClient,
    toast: deps.toast || showToast,
  };
}
