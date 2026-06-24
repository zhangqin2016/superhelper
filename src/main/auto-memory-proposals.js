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

function extractMemoryProposalFromRecord(record = {}) {
  if (record.terminal && !["turn.completed", "turn.interrupted"].includes(record.terminal)) return null;
  const text = normalizeProposalText(record.user?.text || "");
  if (!text) return null;

  if (/^(记住|请记住|帮我记住)\s*[:：,，]?|^(remember|please remember)\b/i.test(text)) {
    const value = stripRememberPrefix(text);
    if (value.length >= MIN_MEMORY_CHARS) return { text: value, source: "explicit_remember" };
  }

  const correctionMatch = text.match(/(?:不是这个意思|不对|以后|下次|以后都|以后.*?先|以后.*?不要)([\s\S]{8,220})/);
  if (correctionMatch) {
    const value = normalizeProposalText(correctionMatch[0]);
    if (value.length >= MIN_MEMORY_CHARS) return { text: value, source: "user_correction" };
  }

  return null;
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
  dismissMemoryProposal,
  extractMemoryProposalFromRecord,
  listMemoryProposals,
  normalizeProposalText,
  promoteMemoryProposalsFromRecord,
  proposalKey,
  proposalsPath,
};
