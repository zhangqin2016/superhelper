// How the phone words what the desktop waits on its user for. The desktop
// sends WHAT is asked (src/main/mobile/prompt-view.js: kind, tool, operation,
// accepted actions); these are the words, the same as the desktop's own cards
// say (renderer zh-CN locale) — test-mobile-prompts holds each equal to it.

export const PROMPT_COPY = Object.freeze({
  permissionTitle: "需要你的确认",
  planTitle: "方案已就绪，开始执行？",
  hookTitle: "需要确认操作",
  questionTitle: "助手需要你补充信息",
  subagentQuestionTitle: "子任务需要你选择",
  subagentPrefix: "子任务",
  toolFallback: "工具调用",
  questionFallback: "请补充你的回答。",
});

// Desktop locale keys permission.kind.<camelCase tool> — the same words.
export const TOOL_LABELS = Object.freeze({
  bash: "运行命令",
  edit: "修改文件",
  write: "写入文件",
  read: "读取文件",
  webfetch: "访问网页",
  websearch: "联网搜索",
  external_directory: "访问工作区以外的目录",
});

const ACTION_COPY = Object.freeze({
  permission: { approve: { label: "批准", primary: true }, approve_remember: { label: "批准并记住" }, deny: { label: "拒绝", danger: true } },
  plan: { approve: { label: "批准并开始执行", primary: true }, keep_planning: { label: "继续完善方案" } },
  hook: { approve: { label: "允许", primary: true }, deny: { label: "拒绝", danger: true } },
});

function permissionLabel(prompt) {
  const label = TOOL_LABELS[prompt.tool];
  const base = label ? (prompt.toolTitle ? `${label}（${prompt.toolTitle}）` : label) : (prompt.toolTitle || prompt.tool || PROMPT_COPY.toolFallback);
  return prompt.subagent ? `${PROMPT_COPY.subagentPrefix} · ${base}` : base;
}

/** A prompt from the desktop → the card the phone renders. */
export function promptCardView(prompt) {
  const actions = (prompt.actions || [])
    .map((id) => ({ id, ...(ACTION_COPY[prompt.kind]?.[id] || { label: id }) }));
  switch (prompt.kind) {
    case "question":
      return {
        title: prompt.subagent ? PROMPT_COPY.subagentQuestionTitle : PROMPT_COPY.questionTitle,
        questions: (prompt.questions || []).map((q) => ({ ...q, question: q.question || PROMPT_COPY.questionFallback })),
        actions,
      };
    case "plan":
      return { title: PROMPT_COPY.planTitle, detail: prompt.plan || "", actions };
    case "hook":
      return { title: PROMPT_COPY.hookTitle, detail: prompt.hookName || "Hook", actions };
    default:
      return { title: PROMPT_COPY.permissionTitle, detail: permissionLabel(prompt), operation: prompt.operation || "", actions };
  }
}
