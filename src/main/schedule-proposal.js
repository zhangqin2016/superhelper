"use strict";

// A turn whose agent called lily_schedule_propose ends with the same pending
// "自动执行" confirmation card a scheduled-task message gets before the engine
// runs: the draft is built here from the tool's structured result (the last
// successful proposal wins) and validated by the same normalizer the model
// draft parser uses. Nothing is created until the user confirms the card.
const { getLogger } = require("./logger");
const { normalizeModelDraft } = require("./scheduled-task-ai-draft");

const log = getLogger("schedule-proposal");
const TOOL_SUFFIX = "lily_schedule_propose";

function parsed(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}

function proposalFromResult(result) {
  const direct = parsed(result);
  const candidates = [direct, parsed(direct?.content), parsed(direct?.result)];
  for (const item of Array.isArray(direct?.content) ? direct.content : []) candidates.push(parsed(item?.text));
  const hit = candidates.find((value) => value?.ok === true && value.proposal && typeof value.proposal === "object");
  return hit?.proposal || null;
}

function isProposalTool(tool = {}) {
  return String(tool?.name || "").toLowerCase().endsWith(TOOL_SUFFIX)
    && !/fail|error|cancel/i.test(String(tool?.status || ""));
}

/**
 * @param {{tools: Iterable<object>, sessionId: string, projectId: string, userText?: string}} input
 * @returns {object|null} a pending scheduledDraft for the turn's terminal payload
 */
function scheduledDraftFromTurnTools({ tools = [], sessionId = "", projectId = "", userText = "" } = {}) {
  const list = [...(tools || [])].filter(isProposalTool);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const proposal = proposalFromResult(list[i].result ?? list[i].output);
    if (!proposal) continue;
    const normalized = normalizeModelDraft(proposal, { sessionId, projectId, text: userText });
    if (!normalized.ok) {
      log.warn("schedule proposal rejected: session=%s error=%s", sessionId, normalized.error);
      continue;
    }
    return {
      status: "pending",
      source: "agent_tool",
      originalText: String(userText || ""),
      draft: normalized.draft,
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}

module.exports = { scheduledDraftFromTurnTools, proposalFromResult };
