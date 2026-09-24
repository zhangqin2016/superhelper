"use strict";

/**
 * What the session is waiting on its user for, as the phone is told it — and
 * the phone's answer, as the desktop's own answer.
 *
 * A task that needs a permission, a plan approval, a hook decision or an
 * answer stops until someone at the desktop acts; a phone that cannot act
 * leaves remote control stuck at the first question. So each pending prompt
 * becomes a card the phone can answer, and the answer goes through the same
 * orchestrator seams the desktop's cards use (respondPermission /
 * respondUserQuestion / respondHook), with the same decision shapes.
 *
 * Pure. The kinds follow the desktop's prompt model (renderer
 * turn-prompt-model.js): questions → question, hookName → hook,
 * ExitPlanMode → plan, else permission. The desktop sends WHAT is asked — the
 * kind, the tool, the operation, the actions it accepts — and the phone page
 * words it (web/lib/mobile/prompt-copy.mjs): the main process does not reach
 * into the renderer for copy. Only operation fields of a permission (command,
 * path, patterns) travel — never the tool's arbitrary input, which may carry
 * credentials.
 */

const capped = (value, max) => {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const MAX = { title: 200, operation: 600, plan: 4000, question: 500, option: 120, optionDetail: 240, questions: 6, options: 12 };

/** The actions each kind accepts; the phone words them. */
const ACTIONS = Object.freeze({
  permission: ["approve", "approve_remember", "deny"],
  plan: ["approve", "keep_planning"],
  hook: ["approve", "deny"],
  question: [],
});

// The desktop's own instruction when a plan is sent back (renderer
// plan.keepPlanningMessage) — it goes to the model, so it is the desktop's.
const KEEP_PLANNING_MESSAGE = "请继续完善方案，暂不执行。";

function promptKind(item) {
  if (Array.isArray(item?.questions)) return "question";
  if (item && Object.prototype.hasOwnProperty.call(item, "hookName")) return "hook";
  if (String(item?.toolName || "") === "ExitPlanMode") return "plan";
  return "permission";
}

function operationDetails(input = {}) {
  const values = [input.command, input.cmd, input.filePath, input.file_path, input.path,
    ...(Array.isArray(input.permissionPatterns) ? input.permissionPatterns : [])];
  return [...new Set(values.filter((v) => typeof v === "string" && v.trim()))].join("\n");
}

/** One pending prompt → what the phone is told, or null when it names no request. */
function phonePrompt(item) {
  const requestId = String(item?.requestId || "");
  if (!requestId) return null;
  const kind = promptKind(item);
  const base = { requestId, kind, actions: ACTIONS[kind].slice(), ...(item.subagent?.sessionId ? { subagent: true } : {}) };
  if (kind === "question") {
    return {
      ...base,
      questions: item.questions.slice(0, MAX.questions).map((q) => ({
        question: capped(q?.question, MAX.question),
        header: capped(q?.header, 60),
        multiSelect: Boolean(q?.multiSelect),
        options: (Array.isArray(q?.options) ? q.options : []).slice(0, MAX.options).map((o) => ({
          label: capped(typeof o === "string" ? o : o?.label, MAX.option),
          description: capped(typeof o === "string" ? "" : o?.description, MAX.optionDetail),
        })).filter((o) => o.label),
      })),
    };
  }
  if (kind === "plan") return { ...base, plan: capped(item.planPreview || item.input?.plan, MAX.plan) };
  if (kind === "hook") return { ...base, hookName: capped(item.hookName, MAX.title) };
  return {
    ...base,
    tool: capped(item.toolName, 60),
    ...(item.title ? { toolTitle: capped(item.title, MAX.title) } : {}),
    operation: capped(operationDetails(item.input || {}), MAX.operation),
  };
}

function phonePrompts(items) {
  return (Array.isArray(items) ? items : []).map(phonePrompt).filter(Boolean);
}

/**
 * The phone's answer → { method, decision } for the orchestrator, or
 * { error } when it does not fit the prompt it answers.
 */
function desktopResponse(item, answer = {}) {
  const kind = promptKind(item);
  const action = String(answer.action || "");
  if (kind === "question") {
    const answers = Array.isArray(answer.answers) ? answer.answers.slice(0, MAX.questions) : null;
    if (!answers) return { error: "PROMPT_ANSWER_INVALID" };
    return {
      method: "respondUserQuestion",
      decision: { answers: answers.map((a) => (Array.isArray(a) ? a.map((v) => capped(v, 2000)) : capped(a, 2000))) },
    };
  }
  if (!ACTIONS[kind].includes(action)) return { error: "PROMPT_ACTION_INVALID" };
  if (kind === "hook") return { method: "respondHook", decision: { allow: action === "approve" } };
  if (kind === "plan") {
    return action === "approve"
      ? { method: "respondPermission", decision: { allow: true } }
      : { method: "respondPermission", decision: { allow: false, message: KEEP_PLANNING_MESSAGE } };
  }
  return { method: "respondPermission", decision: { allow: action !== "deny", remember: action === "approve_remember" } };
}

module.exports = { phonePrompts, phonePrompt, desktopResponse, promptKind, ACTIONS, KEEP_PLANNING_MESSAGE, MAX };
