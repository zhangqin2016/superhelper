"use strict";

// Whether a message asks for scheduled work is the model's call, made while it
// answers, as in ChatGPT: a turn whose agent called lily_schedule_propose ends
// with the pending "自动执行" confirmation card under its answer (the last
// successful proposal wins, validated by the model-draft normalizer). Nothing
// is created until the user confirms the card.
const { getLogger } = require("./logger");
const { normalizeModelDraft } = require("./scheduled-task-ai-draft");
const { looksLikeScheduledTaskIntent } = require("./scheduled-task-intent");
const { parseDraft } = require("./scheduled-task-draft");

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
    return pendingDraft("agent_tool", userText, normalized.draft);
  }
  return null;
}

// withAnswer: the card sits under the answer it came with, and declining it
// declines the schedule only (a pre-engine card replaced the answer instead).
function pendingDraft(source, userText, draft) {
  return { status: "pending", source, withAnswer: true, originalText: String(userText || ""), draft, createdAt: new Date().toISOString() };
}

/**
 * The card for a turn: the agent's proposal first; when the agent proposed
 * nothing but the user plainly asked for scheduled work ("每天 9 点提醒我…"),
 * the local schedule parser drafts it — after the answer, never instead of it.
 * A scheduled run never proposes another schedule.
 */
function scheduledDraftForTurn({ tools = [], sessionId = "", projectId = "", userText = "", files = [], scheduledRun = false } = {}) {
  if (scheduledRun) return null;
  const proposed = scheduledDraftFromTurnTools({ tools, sessionId, projectId, userText });
  if (proposed) return proposed;
  if (!looksLikeScheduledTaskIntent(userText, files)) return null;
  const parsedDraft = parseDraft({ text: userText, sessionId, projectId });
  if (!parsedDraft?.ok) return null;
  log.info("schedule card from the user's request (the agent proposed none): session=%s", sessionId);
  return pendingDraft("intent_fallback", userText, parsedDraft.draft);
}

module.exports = { scheduledDraftForTurn, scheduledDraftFromTurnTools, proposalFromResult };
