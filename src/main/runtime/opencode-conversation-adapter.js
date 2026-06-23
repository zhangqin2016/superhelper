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
    conversation,
    total: Number.isInteger(input.total) ? input.total : conversation.length,
    hasMore: cursor ? !complete : false,
    before: input.before || null,
    nextBefore: cursor,
  };
}

module.exports = {
  adaptOpencodeMessageItem,
  adaptOpencodeMessagesPage,
};
