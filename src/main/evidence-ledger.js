"use strict";

const path = require("node:path");
const { commandExternalEvidenceKind, resolveToolSemantics } = require("./tool-semantics");

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

function normalizePathKey(value = "") {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function pathMatchesCandidate(file = "", candidate = "") {
  const readPath = normalizePathKey(file);
  const candidatePath = normalizePathKey(candidate);
  if (!readPath || !candidatePath) return false;
  if (readPath === candidatePath) return true;
  if (readPath.endsWith(`/${candidatePath}`) || candidatePath.endsWith(`/${readPath}`)) return true;
  const readBase = path.basename(readPath);
  const candidateBase = path.basename(candidatePath);
  return Boolean(readBase && candidateBase && readBase === candidateBase);
}

function normalizeToolEvidence(tool = {}) {
  const name = toolName(tool);
  const input = tool.input || {};
  const result = tool.result ?? tool.content ?? "";
  const status = String(tool.status || "").toLowerCase();
  const success = status !== "failed" && status !== "error";
  const base = { tool: name || "unknown", success, timestamp: Date.now() };
  const semantics = resolveToolSemantics(tool);
  const evidenceKind = semantics?.evidenceKind || "tool_observation";

  if (evidenceKind === "file_search" || ["grep", "glob", "rg", "search"].includes(name)) {
    return {
      ...base,
      kind: "file_search",
      query: firstString(input, ["pattern", "query", "glob", "path"]) || "",
      candidates: extractPathCandidates(result),
    };
  }

  if (evidenceKind === "file_read" || ["read", "notebookread"].includes(name)) {
    return {
      ...base,
      kind: "file_read",
      path: firstString(input, ["file_path", "path", "filePath", "notebook_path"]),
      lines: normalizeLines(input),
    };
  }

  if (evidenceKind === "file_write" || ["write", "edit", "multiedit", "notebookedit"].includes(name)) {
    return {
      ...base,
      kind: "file_write",
      path: firstString(input, ["file_path", "path", "filePath", "notebook_path", "target_file"]) || extractPathCandidates(result, 1)[0] || "",
    };
  }

  if (name === "bash") {
    const command = firstString(input, ["command", "cmd"]);
    const externalKind = commandExternalEvidenceKind(command);
    return {
      ...base,
      kind: externalKind || (commandLooksLikeVerification(command) ? "verification" : "command"),
      command,
      ...(externalKind ? { query: command.slice(0, 2000) } : {}),
    };
  }

  if (["web_search", "web_fetch"].includes(evidenceKind) || ["websearch", "web_search", "webfetch", "web_fetch"].includes(name)) {
    return {
      ...base,
      kind: evidenceKind === "web_search" || name.includes("search") ? "web_search" : "web_fetch",
      query: firstString(input, ["query", "q", "url"]),
    };
  }

  if (/(?:^|[_.-])(?:finance|weather|sports|news|market|browser|http|api)(?:[_.-]|$)/i.test(name)) {
    return {
      ...base,
      kind: "external_observation",
      query: firstString(input, ["query", "q", "url", "ticker", "location", "endpoint"]),
    };
  }

  return { ...base, kind: "tool_observation" };
}

function normalizeSourceContentEvidence(input = {}) {
  const sourceCount = Math.max(0, Number(input.sourceCount || 0));
  const observedCount = Math.max(0, Number(input.observedCount || 0));
  const failedCount = Math.max(0, Number(input.failedCount || 0));
  const status = String(input.status || (observedCount > 0 ? "partial" : "unavailable")).toLowerCase();
  const success = ["available", "complete", "partial"].includes(status) && sourceCount > 0 && (
    status === "available" || observedCount > 0
  );
  return {
    kind: "source_content",
    sourceType: String(input.sourceType || "unknown"),
    method: String(input.method || "unknown"),
    status,
    sourceCount,
    observedCount,
    failedCount,
    extractedChars: Math.max(0, Number(input.extractedChars || 0)),
    coverageLimited: Boolean(input.coverageLimited),
    complete: Boolean(input.complete || (status === "complete" && observedCount >= sourceCount && sourceCount > 0)),
    success,
    timestamp: Date.now(),
  };
}

class EvidenceLedger {
  constructor() {
    this.events = [];
    this.workspaceCandidates = new Map();
    this.documents = [];
    this.sourceContent = [];
  }

  addWorkspaceCandidates(candidates = []) {
    for (const item of candidates || []) {
      const relativePath = normalizePathKey(item?.relativePath || item?.path || item || "");
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

  recordDocumentExtraction(documentEvidence = {}) {
    const documents = Array.isArray(documentEvidence.documents) ? documentEvidence.documents : [];
    const chunks = Array.isArray(documentEvidence.chunks) ? documentEvidence.chunks : [];
    this.recordSourceContentObservation({
      sourceType: "document",
      method: documentEvidence.method || "local_document_extraction",
      status: documentEvidence.status || (documents.length || chunks.length ? "complete" : "unavailable"),
      sourceCount: documentEvidence.sourceCount || documents.length,
      observedCount: documentEvidence.observedCount || documents.length,
      failedCount: documentEvidence.failedCount || 0,
      extractedChars: documentEvidence.extractedChars || documents.reduce((total, doc) => total + Number(doc?.charLength || 0), 0),
      coverageLimited: documentEvidence.coverageLimited,
      complete: documentEvidence.complete ?? Boolean(documents.length || chunks.length),
    });
    if (!documents.length && !chunks.length) return null;
    const event = {
      kind: "document_extraction",
      documents: documents.map((doc) => ({
        id: String(doc.id || ""),
        label: String(doc.label || ""),
        charLength: Number(doc.charLength || 0),
      })),
      chunkCount: chunks.length,
      timestamp: Date.now(),
    };
    this.documents.push(event);
    this.events.push({ kind: "document_evidence", success: true, timestamp: event.timestamp });
    return event;
  }

  recordSourceContentObservation(evidence = {}) {
    const event = normalizeSourceContentEvidence(evidence);
    if (!event.sourceCount && event.status === "unavailable") return null;
    this.sourceContent.push(event);
    this.events.push(event);
    return event;
  }

  recordVisionObservation(visionEvidence = {}) {
    return this.recordSourceContentObservation({ sourceType: "image", ...visionEvidence });
  }

  summary() {
    const filesRead = new Set();
    const searches = [];
    const verifications = [];
    const writes = [];
    const external = [];
    for (const event of this.events) {
      if (event.kind === "file_search") searches.push(event);
      if (event.kind === "file_read" && event.path) filesRead.add(normalizePathKey(event.path));
      if (event.kind === "verification") verifications.push(event);
      if (event.kind === "file_write" && event.path) writes.push(event);
      if (["web_search", "web_fetch", "external_observation"].includes(event.kind)) external.push(event);
    }
    const documentCount = this.documents.reduce((count, event) => count + event.documents.length, 0);
    const documentChunkCount = this.documents.reduce((count, event) => count + Number(event.chunkCount || 0), 0);
    const successfulSourceContent = this.sourceContent.filter((event) => event.success);
    const sourceCount = this.sourceContent.reduce((count, event) => count + event.sourceCount, 0);
    const observedSourceCount = this.sourceContent.reduce((count, event) => count + event.observedCount, 0);
    const hasUnavailableSource = this.sourceContent.some((event) => !event.success);
    const hasAvailableOnlySource = successfulSourceContent.some((event) => event.status === "available");
    const sourceContentStatus = !this.sourceContent.length
      ? "none"
      : !successfulSourceContent.length
        ? "unavailable"
        : hasUnavailableSource || successfulSourceContent.some((event) => event.status === "partial")
          ? "partial"
          : hasAvailableOnlySource
            ? "available"
            : "complete";
    const candidates = [...this.workspaceCandidates.keys()];
    const inspectedCandidates = candidates.filter((candidate) => [...filesRead].some((file) => pathMatchesCandidate(file, candidate)));
    const missingCandidates = candidates.filter((candidate) => !inspectedCandidates.includes(candidate));
    const inspectedReadFiles = [...filesRead].filter((file) => candidates.some((candidate) => pathMatchesCandidate(file, candidate)));
    const candidateCount = candidates.length;
    const inspectedCount = inspectedCandidates.length;
    const inspectedRatio = candidateCount > 0 ? inspectedCount / candidateCount : 0;
    return {
      schemaVersion: 1,
      counts: {
        events: this.events.length,
        fileSearches: searches.length,
        filesRead: filesRead.size,
        verifications: verifications.length,
        fileWrites: writes.length,
        webSources: external.filter((event) => event.kind === "web_search" || event.kind === "web_fetch").length,
        externalSources: external.length,
        documents: documentCount,
        documentChunks: documentChunkCount,
        sourceContentSources: sourceCount,
        sourceContentObservations: this.sourceContent.length,
      },
      coverage: {
        candidateCount,
        inspectedCount,
        inspectedRatio,
        fullInspection: candidateCount > 0 && inspectedCount >= candidateCount,
        candidates: candidates.slice(0, 50),
        inspectedCandidates: inspectedCandidates.slice(0, 50),
        missingCandidates: missingCandidates.slice(0, 50),
        inspected: inspectedReadFiles.slice(0, 50),
        readFiles: [...filesRead].slice(0, 50),
      },
      hasSearchEvidence: searches.length > 0 || candidates.length > 0,
      hasFileReadEvidence: filesRead.size > 0,
      hasVerificationEvidence: verifications.some((event) => event.success),
      hasFileChangeEvidence: writes.length > 0,
      hasFreshEvidence: external.some((event) => event.success),
      hasDocumentEvidence: documentCount > 0 || documentChunkCount > 0,
      hasSourceContentEvidence: successfulSourceContent.length > 0,
      sourceContentCoverage: {
        status: sourceContentStatus,
        sourceCount,
        observedCount: observedSourceCount,
        complete: sourceContentStatus === "complete",
      },
      sourceContent: this.sourceContent.slice(-20),
      documents: this.documents.slice(-20),
      events: this.events.slice(-50),
    };
  }
}

module.exports = {
  EvidenceLedger,
  normalizeToolEvidence,
};
