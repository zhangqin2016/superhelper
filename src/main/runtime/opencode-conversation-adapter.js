"use strict";

function roleOf(info = {}) {
  return info.role === "user" ? "user" : "assistant";
}

function timestampOf(info = {}) {
  const created = info.time?.created;
  if (Number.isFinite(created)) return new Date(created).toISOString();
  return new Date().toISOString();
}

function textFromParts(parts = [], type) {
  return (parts || [])
    .filter((part) => part?.type === type && !part.ignored && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function assistantTextFromOpenCodeMessageItem(item = {}) {
  const info = item?.info || {};
  if (roleOf(info) !== "assistant") return "";
  const parts = Array.isArray(item?.parts) ? item.parts : [];
  return textFromParts(parts, "text").trim();
}

function fileFromPart(part = {}) {
  if (part.type !== "file") return null;
  const path = part.source?.type === "file" ? part.source.path : "";
  return {
    name: part.filename || path.split(/[\\/]/).pop() || "file",
    ...(path ? { path } : {}),
    ...(part.url ? { uri: part.url } : {}),
    ...(part.mime ? { mime: part.mime } : {}),
  };
}

function usageFromInfo(info = {}) {
  const tokens = info.tokens || null;
  if (!tokens) return null;
  const cache = tokens.cache || {};
  return {
    input_tokens: tokens.input || 0,
    output_tokens: (tokens.output || 0) + (tokens.reasoning || 0),
    cache_read_input_tokens: cache.read || 0,
    cache_creation_input_tokens: cache.write || 0,
  };
}

function mergeTextParts(values = []) {
  const out = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.join("\n\n");
}

function sumUsage(usages = []) {
  const present = usages.filter(Boolean);
  if (!present.length) return null;
  return present.reduce((acc, usage) => ({
    input_tokens: acc.input_tokens + (usage.input_tokens || 0),
    output_tokens: acc.output_tokens + (usage.output_tokens || 0),
    cache_read_input_tokens: acc.cache_read_input_tokens + (usage.cache_read_input_tokens || 0),
    cache_creation_input_tokens: acc.cache_creation_input_tokens + (usage.cache_creation_input_tokens || 0),
  }), {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
}

function timestampMs(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : null;
}

function recordTimeRange(record = {}, message = {}) {
  const start = timestampMs(record.startedAt) ?? timestampMs(message.timestamp);
  const end = timestampMs(record.endedAt) ?? (
    Number.isFinite(record.durationMs) && Number.isFinite(start)
      ? start + record.durationMs
      : timestampMs(message.timestamp)
  );
  return { start, end };
}

function mergeAssistantGroup(group = []) {
  if (group.length <= 1) return group[0] || null;
  const first = group[0];
  const last = group[group.length - 1];
  const firstRecord = first.record || {};
  const lastRecord = last.record || {};
  const startedAt = Math.min(
    ...group.map((m) => recordTimeRange(m.record, m).start).filter((n) => Number.isFinite(n)),
  );
  const endedAt = Math.max(
    ...group.map((m) => recordTimeRange(m.record, m).end).filter((n) => Number.isFinite(n)),
  );
  const assistantText = mergeTextParts(group.map((m) => m.content || m.record?.assistantText || ""));
  const thinkingText = mergeTextParts(group.map((m) => m.record?.thinkingText || ""));
  const usage = sumUsage(group.map((m) => m.record?.usage));
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt
    ? endedAt - startedAt
    : lastRecord.durationMs ?? firstRecord.durationMs ?? null;
  const totalCostUsd = group.reduce((sum, message) => {
    const cost = message.record?.totalCostUsd;
    return Number.isFinite(cost) ? sum + cost : sum;
  }, 0);
  const hasCost = group.some((message) => Number.isFinite(message.record?.totalCostUsd));
  const timeline = group.flatMap((m) => m.record?.timeline || []);
  const processEvents = group.flatMap((m) => m.record?.processEvents || []);
  const notices = group.flatMap((m) => m.record?.notices || []);
  const contentBlocks = group.flatMap((m) => m.record?.contentBlocks || []);
  const protocolUnknown = group.flatMap((m) => m.record?.protocolUnknown || []);
  const files = group.flatMap((m) => m.files || []);
  return {
    ...last,
    content: assistantText,
    files: files.length ? files : undefined,
    failed: group.some((m) => m.failed),
    record: {
      ...firstRecord,
      ...lastRecord,
      assistantText,
      thinkingText,
      contentBlocks,
      protocolUnknown,
      processEvents,
      timeline,
      notices,
      durationMs,
      startedAt: Number.isFinite(startedAt) ? startedAt : firstRecord.startedAt ?? null,
      endedAt: Number.isFinite(endedAt) ? endedAt : lastRecord.endedAt ?? null,
      totalCostUsd: hasCost ? totalCostUsd : lastRecord.totalCostUsd ?? firstRecord.totalCostUsd ?? null,
      usage,
      meta: {
        ...(firstRecord.meta || {}),
        ...(lastRecord.meta || {}),
        opencode: {
          ...(lastRecord.meta?.opencode || {}),
          mergedAssistantMessageIds: group.map((m) => m.engineMessageId || m.id).filter(Boolean),
        },
      },
    },
  };
}

function coalesceAssistantMessageRuns(messages = []) {
  const out = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const merged = mergeAssistantGroup(pending);
    if (merged) out.push(merged);
    pending = [];
  };
  for (const message of messages) {
    if (message?.role === "assistant") {
      pending.push(message);
      continue;
    }
    flush();
    out.push(message);
  }
  flush();
  return out;
}

function adaptOpencodeMessageItem(item = {}, opts = {}) {
  const info = item.info || {};
  const parts = Array.isArray(item.parts) ? item.parts : [];
  const role = roleOf(info);
  const content = textFromParts(parts, "text");
  const thinkingText = textFromParts(parts, "reasoning");
  const files = parts.map(fileFromPart).filter(Boolean);
  const usage = usageFromInfo(info);
  const message = {
    id: info.id || item.id || "",
    role,
    content,
    timestamp: timestampOf(info),
    engineMessageId: info.id || "",
    source: "opencode",
  };
  if (files.length) message.files = files;
  if (opts.turnId) message.turnId = opts.turnId;
  if (role === "assistant") {
    message.record = {
      turnId: opts.turnId || null,
      sessionId: opts.sessionId || info.sessionID || null,
      terminal: info.error ? "turn.failed" : "turn.completed",
      user: null,
      assistantText: content,
      thinkingText,
      contentBlocks: [],
      protocolUnknown: [],
      tools: [],
      fileChanges: [],
      artifacts: [],
      resultBlocks: [],
      timeline: [],
      activityLabel: null,
      durationMs: Number.isFinite(info.time?.completed) && Number.isFinite(info.time?.created)
        ? Math.max(0, info.time.completed - info.time.created)
        : null,
      startedAt: Number.isFinite(info.time?.created) ? info.time.created : null,
      endedAt: Number.isFinite(info.time?.completed) ? info.time.completed : null,
      totalCostUsd: Number.isFinite(info.cost) ? info.cost : null,
      engineMessageId: info.id || null,
      processEvents: [],
      notices: [],
      usage,
      meta: {
        terminal: info.error ? "turn.failed" : "turn.completed",
        failed: Boolean(info.error),
        interrupted: false,
        stalled: false,
        resultFromCli: false,
        toolsSummary: { count: 0 },
        opencode: {
          messageId: info.id || "",
          providerID: info.providerID || "",
          modelID: info.modelID || "",
          agent: info.agent || "",
          finish: info.finish || "",
        },
      },
    };
    if (info.error) message.failed = true;
  }
  return message;
}

function adaptOpencodeMessagesPage(input = {}) {
  const items = Array.isArray(input.items)
    ? input.items
    : Array.isArray(input.data)
      ? input.data
      : [];
  const conversation = items
    .map((item) => adaptOpencodeMessageItem(item, {
      sessionId: input.sessionId,
      turnIdByMessageId: input.turnIdByMessageId,
    }))
    .filter((message) => message.id);
  const cursor = input.cursor || input.nextBefore || null;
  const complete = Boolean(input.complete);
  return {
    ok: true,
    source: "opencode",
    sessionId: input.sessionId || null,
    projectId: input.projectId || null,
    conversation: coalesceAssistantMessageRuns(conversation),
    total: Number.isInteger(input.total) ? input.total : conversation.length,
    hasMore: cursor ? !complete : false,
    before: input.before || null,
    nextBefore: cursor,
  };
}

module.exports = {
  adaptOpencodeMessageItem,
  adaptOpencodeMessagesPage,
  assistantTextFromOpenCodeMessageItem,
  coalesceAssistantMessageRuns,
};
