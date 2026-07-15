"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const MIN_MEMORY_CHARS = 10;

function safeProjectFile(projectId) {
  return `${String(projectId || "default").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function proposalsPath(projectId) {
  return userDataPath("memory-proposals", safeProjectFile(projectId));
}

function normalizeProposalText(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[\s:：,，。.!！?？-]+|[\s:：,，。.!！?？-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function proposalKey(value) {
  return normalizeProposalText(value)
    .toLowerCase()
    .replace(/[。.!！?？,，;；:：\s]+/g, "");
}

function stripRememberPrefix(text) {
  return normalizeProposalText(String(text || "").replace(/^(记住|请记住|帮我记住|remember|please remember)\s*[:：,，]?\s*/i, ""));
}

// A tool "errored" if the engine marked it failed/error, or its result flagged
// an error. Used to detect a genuine struggle→recovery (a reusable debugging win).
function toolErrored(tool) {
  if (!tool) return false;
  if (/error|fail/i.test(String(tool.status || ""))) return true;
  const r = tool.result;
  return Boolean(r && typeof r === "object" && (r.is_error || r.isError));
}

// Autonomous solution learning (OPT-IN: LILY_MEMORY_LEARN_SOLUTIONS=1). Distills a
// reusable "how it was solved" note from a turn that OVERCAME tool errors and still
// completed — a high-precision, low-noise signal (skips trivial one-shot successes,
// so it can't spam the approval queue). Human-approved like every other proposal;
// deterministic (no model call, never blocks the turn). null when the signal is weak.
function detectSolutionLesson(record = {}) {
  if (process.env.LILY_MEMORY_LEARN_SOLUTIONS !== "1") return null;
  if (record.terminal !== "turn.completed") return null;
  const problem = normalizeProposalText(record.user?.text || "");
  if (problem.length < 20) return null; // needs a substantive problem to be a lesson
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const errored = tools.filter(toolErrored);
  if (!errored.length) return null; // require a real struggle→recovery, not a trivial win
  const usedTools = [...new Set(tools.map((t) => t && t.name).filter(Boolean))].slice(0, 6);
  if (!usedTools.length) return null;
  const problemShort = problem.length > 100 ? `${problem.slice(0, 99)}…` : problem;
  const text = normalizeProposalText(
    `处理「${problemShort}」的有效路径:${usedTools.join(" → ")}（克服了 ${errored.length} 处报错）`,
  );
  if (text.length < MIN_MEMORY_CHARS) return null;
  return { text, source: "distilled_solution" };
}

function extractMemoryProposalFromRecord(record = {}) {
  if (record.terminal && !["turn.completed", "turn.interrupted"].includes(record.terminal)) return null;
  const text = normalizeProposalText(record.user?.text || "");

  if (text) {
    if (/^(记住|请记住|帮我记住)\s*[:：,，]?|^(remember|please remember)\b/i.test(text)) {
      const value = stripRememberPrefix(text);
      if (value.length >= MIN_MEMORY_CHARS) return { text: value, source: "explicit_remember" };
    }

    const correctionMatch = text.match(/(?:不是这个意思|不对|以后|下次|以后都|以后.*?先|以后.*?不要)([\s\S]{8,220})/);
    if (correctionMatch) {
      const value = normalizeProposalText(correctionMatch[0]);
      if (value.length >= MIN_MEMORY_CHARS) return { text: value, source: "user_correction" };
    }
  }

  // Autonomous solution learning (opt-in) — evaluated last so explicit user intent
  // (remember/correction) always wins.
  return detectSolutionLesson(record);
}

function readProposalFile(projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(proposalsPath(projectId), "utf8"));
    return Array.isArray(parsed?.proposals) ? parsed.proposals : [];
  } catch {
    return [];
  }
}

function writeProposalFile(projectId, proposals) {
  const filePath = proposalsPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, proposals }, null, 2), "utf8");
}

function listMemoryProposals(projectId, { includeDismissed = false } = {}) {
  const proposals = readProposalFile(projectId);
  return includeDismissed ? proposals : proposals.filter((item) => item.status !== "dismissed");
}

function updateProposal(projectId, key, updater) {
  if (!projectId || !key) return null;
  const proposals = readProposalFile(projectId);
  const index = proposals.findIndex((item) => item.key === key);
  if (index < 0) return null;
  const next = updater({ ...proposals[index] });
  proposals[index] = next;
  writeProposalFile(projectId, proposals);
  return next;
}

function approveMemoryProposal(projectId, key, details = {}) {
  return updateProposal(projectId, key, (proposal) => {
    if (proposal.status !== "approved") {
      try {
        require("./learned-context").appendLearnedConvention(projectId, proposal.text);
      } catch {
        // Keep proposal status unchanged if persistence fails.
        throw new Error("learned convention write failed");
      }
    }
    return {
      ...proposal,
      status: "approved",
      approvedAt: details.at || new Date().toISOString(),
      approvedBy: details.approvedBy || "",
    };
  });
}

function dismissMemoryProposal(projectId, key, details = {}) {
  return updateProposal(projectId, key, (proposal) => ({
    ...proposal,
    status: "dismissed",
    dismissedAt: details.at || new Date().toISOString(),
    dismissedBy: details.dismissedBy || "",
  }));
}

function promoteMemoryProposalsFromRecord(projectId, record = {}) {
  const proposal = extractMemoryProposalFromRecord(record);
  if (!projectId || !proposal) return null;
  const key = proposalKey(proposal.text);
  if (!key) return null;
  const existing = readProposalFile(projectId);
  if (existing.some((item) => item.key === key && item.status !== "dismissed")) {
    return { status: "duplicate", key };
  }
  const item = {
    key,
    text: proposal.text,
    source: proposal.source,
    status: "proposed",
    turnId: record.turnId || "",
    createdAt: new Date().toISOString(),
  };
  writeProposalFile(projectId, [...existing, item].slice(-50));
  return { status: "proposed", proposal: item };
}

module.exports = {
  approveMemoryProposal,
  detectSolutionLesson,
  dismissMemoryProposal,
  extractMemoryProposalFromRecord,
  listMemoryProposals,
  normalizeProposalText,
  promoteMemoryProposalsFromRecord,
  proposalKey,
  proposalsPath,
};
