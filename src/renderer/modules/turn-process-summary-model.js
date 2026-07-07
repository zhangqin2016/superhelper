import { classifyToolCategory } from "./turn-tool-model.js";

export function groupToolsByCategory(tools = []) {
  const groups = new Map();
  for (const tool of tools) {
    const cat = classifyToolCategory(tool.name);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(tool);
  }
  return groups;
}

export function processGroupSummary(tools = [], notices = [], translate) {
  const parts = [];
  if (tools.length) {
    parts.push(translate("timeline.stepsCompleted", { count: tools.length }));
  }
  if (notices.length) {
    parts.push(translate("timeline.processNotices", { count: notices.length }));
  }
  return parts.join(" · ");
}

export function categorySummaryKey(category, count) {
  if (category === "read") return ["timeline.summaryRead", { count }];
  if (category === "write") return ["timeline.summaryWrite", { count }];
  if (category === "search") return ["timeline.summarySearch", { count }];
  if (category === "command") return ["timeline.summaryCommand", { count }];
  if (category === "web") return ["timeline.summaryWeb", { count }];
  if (category === "agent") return ["timeline.summaryAgent", { count }];
  return ["timeline.summaryOther", { count }];
}
