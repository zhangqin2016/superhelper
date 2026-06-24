"use strict";

const path = require("node:path");

const PATH_RE = /((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[\w@.-]+[\\/])[\w@./\\-]+\.[A-Za-z0-9]{1,8})(?::\d+)?/g;

function toolName(tool = {}) {
  return String(tool.name || tool.tool || "").toLowerCase();
}

function firstString(input, keys) {
  for (const key of keys) {
    if (typeof input?.[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return "";
}

function extractPathCandidates(value, limit = 80) {
  const out = [];
  const seen = new Set();
  const text = typeof value === "string" ? value.slice(0, 128 * 1024) : JSON.stringify(value || "").slice(0, 128 * 1024);
  for (const match of text.matchAll(PATH_RE)) {
    const candidate = String(match[1] || "").replace(/\\/g, "/");
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeLines(input = {}) {
  const start = Number(input.offset ?? input.start_line ?? input.startLine ?? input.line ?? 0);
  const limit = Number(input.limit ?? input.end_line ?? input.endLine ?? 0);
  if (Number.isFinite(start) && start > 0 && Number.isFinite(limit) && limit > 0) return [start, start + limit];
  if (Number.isFinite(start) && start > 0) return [start, start];
  return null;
}

function commandLooksLikeVerification(command = "") {
  return /\b(npm\s+(?:run\s+)?test|node\s+scripts\/test-|pytest|vitest|jest|playwright|tsc|eslint|lint|cargo\s+test|go\s+test)\b/i.test(command);
}

function normalizeToolEvidence(tool = {}) {
  const name = toolName(tool);
  const input = tool.input || {};
  const result = tool.result ?? tool.content ?? "";
  const status = String(tool.status || "").toLowerCase();
  const success = status !== "failed" && status !== "error";
  const base = { tool: name || "unknown", success, timestamp: Date.now() };

  if (["grep", "glob", "rg", "search"].includes(name)) {
    return {
      ...base,
      kind: "file_search",
      query: firstString(input, ["pattern", "query", "glob", "path"]) || "",
      candidates: extractPathCandidates(result),
    };
  }

  if (["read", "notebookread"].includes(name)) {
    return {
      ...base,
      kind: "file_read",
      path: firstString(input, ["file_path", "path", "filePath", "notebook_path"]),
      lines: normalizeLines(input),
    };
  }

  if (["write", "edit", "multiedit", "notebookedit"].includes(name)) {
    return {
      ...base,
      kind: "file_write",
      path: firstString(input, ["file_path", "path", "filePath", "notebook_path", "target_file"]),
    };
  }

  if (name === "bash") {
    const command = firstString(input, ["command", "cmd"]);
    return {
      ...base,
      kind: commandLooksLikeVerification(command) ? "verification" : "command",
      command,
    };
  }

  if (["websearch", "web_search", "webfetch", "web_fetch"].includes(name)) {
    return {
      ...base,
      kind: name.includes("search") ? "web_search" : "web_fetch",
      query: firstString(input, ["query", "q", "url"]),
    };
  }

  return { ...base, kind: "tool_observation" };
}

class EvidenceLedger {
  constructor() {
    this.events = [];
    this.workspaceCandidates = new Map();
  }

  addWorkspaceCandidates(candidates = []) {
    for (const item of candidates || []) {
      const relativePath = String(item?.relativePath || item?.path || item || "").replace(/\\/g, "/");
      if (!relativePath) continue;
      this.workspaceCandidates.set(relativePath, {
        relativePath,
        path: item?.path || "",
        source: item?.source || "workspace_index",
      });
    }
  }

  recordTool(tool = {}) {
    const event = normalizeToolEvidence(tool);
    this.events.push(event);
    if (event.kind === "file_search") {
      this.addWorkspaceCandidates(event.candidates.map((candidate) => ({ relativePath: candidate, source: "tool_search" })));
    }
    return event;
  }

  summary() {
    const filesRead = new Set();
    const searches = [];
    const verifications = [];
    const writes = [];
    const web = [];
    for (const event of this.events) {
      if (event.kind === "file_search") searches.push(event);
      if (event.kind === "file_read" && event.path) filesRead.add(event.path.replace(/\\/g, "/"));
      if (event.kind === "verification") verifications.push(event);
      if (event.kind === "file_write" && event.path) writes.push(event);
      if (event.kind === "web_search" || event.kind === "web_fetch") web.push(event);
    }
    const candidates = [...this.workspaceCandidates.keys()];
    const inspected = [...filesRead].filter((file) => {
      if (candidates.includes(file)) return true;
      const base = path.basename(file);
      return candidates.some((candidate) => path.basename(candidate) === base || candidate.endsWith(file));
    });
    return {
      schemaVersion: 1,
      counts: {
        events: this.events.length,
        fileSearches: searches.length,
        filesRead: filesRead.size,
        verifications: verifications.length,
        fileWrites: writes.length,
        webSources: web.length,
      },
      coverage: {
        candidateCount: candidates.length,
        inspectedCount: inspected.length,
        candidates: candidates.slice(0, 50),
        inspected: [...filesRead].slice(0, 50),
      },
      hasSearchEvidence: searches.length > 0 || candidates.length > 0,
      hasFileReadEvidence: filesRead.size > 0,
      hasVerificationEvidence: verifications.some((event) => event.success),
      hasFileChangeEvidence: writes.length > 0,
      hasFreshEvidence: web.some((event) => event.success),
      events: this.events.slice(-50),
    };
  }
}

module.exports = {
  EvidenceLedger,
  normalizeToolEvidence,
};
