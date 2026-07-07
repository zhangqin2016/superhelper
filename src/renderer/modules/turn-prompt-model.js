function mapValues(value) {
  if (value instanceof Map) return [...value.values()];
  if (Array.isArray(value)) return value;
  return [];
}

export function buildPromptViewModel(liveTurn = {}) {
  const entries = [
    ...mapValues(liveTurn.permissions),
    ...mapValues(liveTurn.questions),
    ...mapValues(liveTurn.hooks),
  ];
  return {
    entries,
    signature: entries
      .map((item) => `${item.questions ? "q" : item.hookName ? "h" : "p"}:${item.requestId || ""}`)
      .join("|"),
    activeQuestionRequestIds: new Set(entries
      .filter((item) => item.questions)
      .map((item) => String(item.requestId || ""))),
    visible: entries.length > 0,
  };
}

export function promptKindForItem(item) {
  if (item?.questions) return "question";
  if (item && Object.prototype.hasOwnProperty.call(item, "hookName")) return "hook";
  if (String(item?.toolName || "") === "ExitPlanMode") return "plan";
  return "permission";
}

export function promptRendererKeyForKind(kind) {
  if (kind === "question" || kind === "hook" || kind === "plan") return kind;
  return "permission";
}

export function planApprovalViewForItem(item = {}) {
  return {
    planText: String(item.planPreview || item.input?.plan || "").trim(),
    truncated: Boolean(item.planPreviewTruncated),
  };
}

export function permissionActionViews() {
  return [
    { labelKey: "permission.approve", response: { approved: true } },
    { labelKey: "permission.deny", response: { approved: false } },
    { labelKey: "permission.approveRememberShort", response: { approved: true, options: { remember: true } } },
  ];
}

export function planApprovalActionViews(keepPlanningMessage) {
  return [
    { labelKey: "plan.approve", response: { approved: true } },
    { labelKey: "plan.keepPlanning", response: { approved: false, options: { message: keepPlanningMessage } } },
  ];
}

export function hookActionViews() {
  return [
    { labelKey: "hook.allowTool", response: { approved: true } },
    { labelKey: "hook.denyTool", response: { approved: false } },
  ];
}

export function permissionResponseForAction(action = {}) {
  return {
    approved: Boolean(action.response?.approved),
    options: action.response?.options,
  };
}

export function hookResponseForAction(action = {}) {
  return {
    approved: Boolean(action.response?.approved),
  };
}

export function promptCardViewForItem(item, { translate, permissionLabel }) {
  switch (promptKindForItem(item)) {
    case "question":
      return {
        title: item?.subagent?.sessionId
          ? translate("subagent.questionCardTitle")
          : translate("turn.question.cardTitle"),
        detail: "",
      };
    case "hook":
      return {
        title: translate("turn.hook.confirmTitle"),
        detail: item?.hookName || translate("hook.title"),
      };
    case "plan":
      return {
        title: translate("plan.readyTitle"),
        detail: "",
      };
    default:
      return {
        title: translate("permission.approveActionTitle"),
        detail: permissionLabel(item),
      };
  }
}
