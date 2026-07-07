import { renderStreamingMarkdown } from "./markdown.js";
import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";
import {
  actionButton,
  actionRow,
  promptCard,
} from "./turn-prompt-ui.js";
import {
  hookActionViews,
  hookResponseForAction,
  permissionActionViews,
  permissionResponseForAction,
  planApprovalActionViews,
  planApprovalViewForItem,
  promptCardViewForItem,
} from "./turn-prompt-model.js";
import { permissionLabelForView } from "./turn-view-status.js";

function defaultButton(label, action, translate = t) {
  return actionButton(label, action, {
    showToast,
    failureText: translate("common.actionFailed"),
  });
}

function permissionActionButton(sessionId, item, action, deps) {
  const { translate, createButton, assistantClient } = deps;
  const response = permissionResponseForAction(action);
  return createButton(translate(action.labelKey), async () =>
    assistantClient.respondPermission(
      sessionId,
      item.requestId,
      response.approved,
      response.options,
    ));
}

export function permissionCard(sessionId, item, deps = {}) {
  const fullDeps = normalizeDeps(deps);
  const view = promptCardViewForItem(item, {
    translate: fullDeps.translate,
    permissionLabel: fullDeps.permissionLabel,
  });
  const card = fullDeps.createCard(view.title, view.detail);
  const actions = fullDeps.createActions();
  for (const action of permissionActionViews()) {
    actions.appendChild(permissionActionButton(sessionId, item, action, fullDeps));
  }
  card.appendChild(actions);
  return card;
}

export function planApprovalCard(sessionId, item, deps = {}) {
  const fullDeps = normalizeDeps(deps);
  const view = promptCardViewForItem(item, {
    translate: fullDeps.translate,
    permissionLabel: fullDeps.permissionLabel,
  });
  const card = fullDeps.createCard(view.title, view.detail);
  const { planText, truncated } = planApprovalViewForItem(item);
  if (planText) {
    const body = document.createElement("div");
    body.className = "assistant-plan-body markdown-body";
    fullDeps.renderMarkdown(body, planText);
    if (truncated) {
      const more = document.createElement("p");
      more.className = "assistant-plan-truncated";
      more.textContent = fullDeps.translate("plan.truncated");
      body.appendChild(more);
    }
    card.appendChild(body);
  }
  const actions = fullDeps.createActions();
  for (const action of planApprovalActionViews(fullDeps.translate("plan.keepPlanningMessage"))) {
    actions.appendChild(permissionActionButton(sessionId, item, action, fullDeps));
  }
  card.appendChild(actions);
  return card;
}

export function hookCard(sessionId, item, deps = {}) {
  const fullDeps = normalizeDeps(deps);
  const view = promptCardViewForItem(item, {
    translate: fullDeps.translate,
    permissionLabel: fullDeps.permissionLabel,
  });
  const card = fullDeps.createCard(view.title, view.detail);
  const actions = fullDeps.createActions();
  for (const action of hookActionViews()) {
    actions.appendChild(hookActionButton(sessionId, item, action, fullDeps));
  }
  card.appendChild(actions);
  return card;
}

function hookActionButton(sessionId, item, action, deps) {
  const response = hookResponseForAction(action);
  return deps.createButton(deps.translate(action.labelKey), async () =>
    deps.assistantClient.respondHook(sessionId, item.requestId, response.approved));
}

function normalizeDeps(deps) {
  const translate = deps.translate || t;
  return {
    translate,
    permissionLabel: deps.permissionLabel || ((item) => permissionLabelForView(item, translate)),
    createCard: deps.createCard || promptCard,
    createActions: deps.createActions || actionRow,
    createButton: deps.createButton || ((label, action) => defaultButton(label, action, translate)),
    renderMarkdown: deps.renderMarkdown || renderStreamingMarkdown,
    assistantClient: deps.assistantClient || window.assistantClient,
  };
}
