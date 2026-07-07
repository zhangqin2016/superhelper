import { toolPreview } from "./turn-tool-preview.js";

export function buildTimelineFromLegacy(state = {}) {
  const timeline = [];
  const ts = state.startedAt || Date.now();
  if (state.thinkingText?.trim()) {
    timeline.push({
      kind: "thinking",
      id: "think_1",
      ts,
      text: state.thinkingText.trim(),
      collapsed: true,
      status: "done",
    });
  }
  const tools = state.tools instanceof Map ? [...state.tools.values()] : (state.tools || []);
  for (const tool of tools) {
    if (!tool?.id) continue;
    timeline.push({
      kind: "tool",
      id: tool.id,
      ts,
      name: tool.name || "Tool",
      preview: toolPreview(tool),
      input: tool.input || {},
      partialJson: tool.partialJson || "",
      status: tool.status || "done",
      result: tool.result || null,
      metadata: tool.metadata || {},
      title: tool.title || "",
    });
  }
  for (const event of state.notices || []) {
    const notice = event?.payload?.notice || event?.notice || event;
    if (!notice || notice.panel === false) continue;
    timeline.push({
      kind: "notice",
      ts: event.ts || ts,
      code: notice.code || "",
      level: notice.level || "info",
      detail: notice.detail || notice.message || "",
      done: Boolean(notice.done),
      replace: Boolean(notice.replace),
      replacesCode: notice.replacesCode || "",
    });
  }
  return timeline;
}
