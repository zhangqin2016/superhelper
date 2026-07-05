"use strict";

const crypto = require("node:crypto");

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 16);
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").toLowerCase();
}

function opencodeVersion() {
  try {
    return require("@opencode-ai/sdk/package.json").version || "";
  } catch {
    // fall through to the declared dependency range in dev/test layouts where
    // package metadata is not resolvable through the installed package.
  }
  try {
    return require("../../package.json").dependencies?.["@opencode-ai/sdk"] || "";
  } catch {
    return "";
  }
}

function firstUserMessageHash(sessionManager, sessionId) {
  const messages = typeof sessionManager?.getConversation === "function"
    ? sessionManager.getConversation(sessionId) || []
    : [];
  const first = messages.find((message) => message?.role === "user");
  const text = String(first?.content || first?.text || "").replace(/\s+/g, " ").trim();
  return text ? stableHash(text) : "";
}

function skillSetHash(activeSkillIds = []) {
  return stableHash(
    [...new Set((Array.isArray(activeSkillIds) ? activeSkillIds : []).map((id) => String(id || "").trim()).filter(Boolean))]
      .sort()
      .join("\n"),
  );
}

function buildResumeBinding({ session, project, activeSkillIds, sessionManager, resumeId } = {}) {
  return {
    version: 1,
    resumeId: String(resumeId || session?.agentResumeId || "").trim(),
    lilySessionId: String(session?.id || "").trim(),
    projectId: String(session?.projectId || project?.id || "").trim(),
    workspacePathHash: stableHash(normalizePath(project?.path || "")),
    enabledSkillIdsHash: skillSetHash(activeSkillIds),
    firstUserMessageHash: firstUserMessageHash(sessionManager, session?.id),
    opencodeVersion: opencodeVersion(),
    createdAt: new Date().toISOString(),
  };
}

function verifyResumeBinding(session, expected = {}) {
  const actual = session?.agentResumeBinding;
  if (!session?.agentResumeId) return { ok: true, reason: "no_resume" };
  if (!actual || typeof actual !== "object") return { ok: true, reason: "legacy_unbound_resume" };
  const checks = [
    "resumeId",
    "lilySessionId",
    "projectId",
    "workspacePathHash",
    "enabledSkillIdsHash",
    "firstUserMessageHash",
    "opencodeVersion",
  ];
  for (const key of checks) {
    if (key === "firstUserMessageHash" && !actual[key]) continue;
    if (String(actual[key] || "") !== String(expected[key] || "")) {
      return {
        ok: false,
        reason: `binding_${key}_mismatch`,
        expected: String(expected[key] || ""),
        actual: String(actual[key] || ""),
      };
    }
  }
  return { ok: true, reason: "binding_match" };
}

module.exports = {
  buildResumeBinding,
  stableHash,
  verifyResumeBinding,
};
