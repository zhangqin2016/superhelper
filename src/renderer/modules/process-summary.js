function secondsBetween(startedAt, now) {
  const elapsedMs = Math.max(0, Number(now) - (Number(startedAt) || Number(now)));
  return Math.max(1, Math.round(elapsedMs / 1000));
}

function toolGroup(tool = {}) {
  const name = String(tool.name || "").toLowerCase();
  if (name === "read") return "read";
  if (["grep", "glob", "websearch", "web_search_prime"].includes(name)) return "search";
  if (["write", "edit", "multiedit"].includes(name)) return "write";
  if (name === "bash") return "command";
  if (["task", "agent", "subagent"].includes(name)) return "agent";
  if (name === "webreader") return "web";
  return "other";
}

function countToolGroups(tools = []) {
  const counts = { read: 0, search: 0, write: 0, command: 0, web: 0, agent: 0, other: 0 };
  for (const tool of tools) counts[toolGroup(tool)] += 1;
  return counts;
}

function plural(count, singular, pluralText = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralText}`;
}

export function summarizeTurnProcess(liveTurn, now = Date.now()) {
  const tools = [...(liveTurn?.tools?.values?.() || [])];
  const elapsed = secondsBetween(liveTurn?.startedAt, liveTurn?.final?.ts || now);
  const counts = countToolGroups(tools);
  const parts = [];
  if (counts.search) parts.push(`searched for ${plural(counts.search, "pattern")}`);
  if (counts.read) parts.push(`read ${plural(counts.read, "file")}`);
  if (counts.write) parts.push(`changed ${plural(counts.write, "file")}`);
  if (counts.command) parts.push(`ran ${plural(counts.command, "command")}`);
  if (counts.web) parts.push(`checked ${plural(counts.web, "web page")}`);
  if (counts.agent) parts.push(`used ${plural(counts.agent, "assistant")}`);
  if (counts.other) parts.push(`completed ${plural(counts.other, "step")}`);
  return parts.length ? `Thought for ${elapsed}s, ${parts.join(", ")}` : `Thought for ${elapsed}s`;
}

export function processDetailCounts(liveTurn) {
  const processCount = liveTurn?.processEvents?.filter?.((event) => {
    const payload = event?.payload || {};
    if (payload.rawSubtype === "thinking_tokens") return false;
    const actions = payload.actions || [];
    return actions.some((action) => {
      const kind = action?.kind || "";
      if (kind === "stream_tool_start" || kind === "assistant_tool_use" || kind === "tool_result") {
        return false;
      }
      return kind === "assistant_thinking" ||
        kind === "permission_check" ||
        kind === "ask_user_question" ||
        kind.startsWith("hook_");
    });
  })?.length || 0;
  return {
    tools: liveTurn?.tools?.size || 0,
    notices: (liveTurn?.notices?.length || 0) + processCount,
  };
}
