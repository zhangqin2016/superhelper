// Empty-handoff guard for the `task` (subagent) tool, inside the OpenCode
// (Bun) serve process. When a subagent dies without producing text (empty
// completion from a flaky gateway, hard mid-turn abort), the task tool returns
// `<task_result></task_result>` with state="completed" — the parent model
// reads an EMPTY but "successful" handoff, and either fabricates a summary
// from nothing or reports the subtask as mysteriously failed.
//
// Mirror of loop-detector: append a corrective note to the tool output so the
// parent model recovers ITSELF (re-dispatch once with a sharper prompt, or do
// the work inline). No hard-kill, no retry machinery — a false positive costs
// one harmless sentence. FAIL OPEN: must never throw. Kill switch:
// LILY_SUBTASK_GUARD=0.

// Pull a stable text view of a tool result across the shapes the engine passes
// ({output:string}, {content:[{type:"text",text}]}, or a raw value).
function resultText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output.output === "string") return output.output;
  try {
    if (Array.isArray(output.content)) {
      return output.content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
    }
  } catch {
    /* ignore */
  }
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

const NOTE =
  "[subtask] 该子任务返回了空结果（state=completed 但 task_result 没有任何内容）。" +
  "这通常意味着子代理的模型调用异常中断，而不是任务真的完成了。" +
  "不要把空结果当作成功依据。请二选一：" +
  "1) 用更聚焦、更小范围的提示重新派发一次该子任务（只重派一次，不要循环）；" +
  "2) 直接自己完成这部分工作。";

export const SubtaskGuardPlugin = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      if (process.env.LILY_SUBTASK_GUARD === "0") return;
      if (String((input && input.tool) || "") !== "task") return;
      const text = resultText(output);
      if (!text || !/state="completed"/.test(text)) return;
      const match = text.match(/<task_result>([\s\S]*?)<\/task_result>/);
      if (!match || match[1].trim()) return;
      if (output && typeof output === "object") {
        if (typeof output.output === "string") output.output = `${output.output}\n\n${NOTE}`;
        else if (Array.isArray(output.content)) output.content.push({ type: "text", text: NOTE });
      }
    } catch {
      /* fail open — the guard must never break a turn */
    }
  },
});

export default SubtaskGuardPlugin;
