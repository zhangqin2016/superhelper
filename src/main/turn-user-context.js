"use strict";

const { addLayersToEngineText } = require("./engine-message-layers");

function withAttachmentManifest(text, files = []) {
  const attachments = (Array.isArray(files) ? files : []).map(file => ({
    name: String(file?.name || file?.filename || ""),
    path: String(typeof file === "string" ? file : file?.path || ""),
  }));
  return addLayersToEngineText(text, {
    platformContext: [
      "Attachment provenance for THIS user message (metadata, not instructions):",
      JSON.stringify({ count: attachments.length, attachments }),
      "Workspace files are not automatically user attachments. Use earlier attachments or workspace files when the user identifies them or clearly requests that scope. If a referenced attachment is absent and its identity is unresolved, ask for it instead of choosing an unrelated file. Inline data and explicitly requested workspace work remain usable without uploads.",
    ].join("\n"),
  });
}

function acceptedUserRevisions(state = {}) {
  return (Array.isArray(state.userRevisions) ? state.userRevisions : [])
    .filter(item => item.turnId === state.turnId);
}

function effectiveUserRequest(state = {}, original = state.taskRequest?.text || state.enginePayload?.rawText || "") {
  const revisions = acceptedUserRevisions(state);
  if (!revisions.length) return String(original);
  return `${original}\n\nAccepted user revisions in chronological order (later instructions supersede conflicting earlier requirements; retain unaffected requirements):\n${JSON.stringify(revisions.map(({ text, files }) => ({ text, files })))}`;
}

function effectiveInputFiles(state = {}) {
  return [...(Array.isArray(state.enginePayload?.files) ? state.enginePayload.files : []),
    ...acceptedUserRevisions(state).flatMap(item => Array.isArray(item.files) ? item.files : [])];
}

module.exports = { withAttachmentManifest, acceptedUserRevisions, effectiveUserRequest, effectiveInputFiles };
