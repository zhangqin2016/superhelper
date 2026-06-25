"use strict";

function node(id, type, label, data = {}) {
  return { id, type, label, data };
}

function edge(from, to, type) {
  return { from, to, type };
}

function isSubagentTool(tool = {}) {
  return String(tool.name || "").toLowerCase() === "task";
}

function buildEvidenceGraph(record = {}) {
  const nodes = [];
  const edges = [];
  const turnId = record.turnId || "turn";
  nodes.push(node(`turn:${turnId}`, "turn", turnId, {
    terminal: record.terminal || "",
    userText: record.user?.text || "",
  }));

  for (const tool of record.tools || []) {
    const id = `tool:${tool.id || tool.name || nodes.length}`;
    nodes.push(node(id, "tool", tool.name || "tool", {
      status: tool.status || "",
      input: tool.input || {},
      durationMs: Number(tool.durationMs || 0),
    }));
    edges.push(edge(`turn:${turnId}`, id, "used_tool"));
  }

  const subagentTools = (record.tools || []).filter((tool) => isSubagentTool(tool));
  for (const taskTool of subagentTools) {
    const id = `subagent:${taskTool.id || nodes.length}`;
    nodes.push(node(id, "subagent_handoff", taskTool.input?.description || taskTool.input?.prompt || taskTool.name || "subagent", {
      toolId: taskTool.id || "",
      status: taskTool.status || "",
      input: taskTool.input || {},
      durationMs: Number(taskTool.durationMs || 0),
    }));
    edges.push(edge(`turn:${turnId}`, id, "delegated_subagent"));
  }

  for (const child of record.tools || []) {
    if (!child.parentToolUseId) continue;
    const parentId = `subagent:${child.parentToolUseId}`;
    const childId = `tool:${child.id || child.name || nodes.length}`;
    if (!nodes.some((item) => item.id === parentId)) {
      nodes.push(node(parentId, "subagent_handoff", child.parentToolUseId, {
        toolId: child.parentToolUseId,
        status: "observed",
      }));
      edges.push(edge(`turn:${turnId}`, parentId, "delegated_subagent"));
    }
    edges.push(edge(parentId, childId, "subagent_used_tool"));
  }

  for (const change of record.fileChanges || []) {
    const id = `file:${change.filePath || change.fileName || nodes.length}`;
    nodes.push(node(id, "file_change", change.fileName || change.filePath || "file", {
      filePath: change.filePath || "",
      status: change.status || "",
      stats: change.stats || null,
    }));
    edges.push(edge(`turn:${turnId}`, id, "changed_file"));
  }

  for (const artifact of record.artifacts || []) {
    const id = `artifact:${artifact.id || artifact.path || nodes.length}`;
    nodes.push(node(id, "artifact", artifact.title || artifact.path || artifact.type || "artifact", {
      type: artifact.type || "",
      path: artifact.path || "",
    }));
    edges.push(edge(`turn:${turnId}`, id, "produced_artifact"));
  }

  if (record.meta?.evidenceGate && record.meta.evidenceGate.ok === false) {
    const id = `evidence_gap:${turnId}`;
    nodes.push(node(id, "evidence_gap", record.meta.evidenceGate.reason || "evidence gap", {
      reason: record.meta.evidenceGate.reason || "",
    }));
    edges.push(edge(`turn:${turnId}`, id, "has_gap"));
  }

  return { schemaVersion: 1, nodes, edges };
}

module.exports = { buildEvidenceGraph };
