"use strict";

const { buildDocumentDeliveryRecoveryPrompt } = require("./document-delivery-recovery-prompt");

function normalizeExpectedArtifactPaths(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

// continuesTurnId: the answer a delivery-check round continues. It is shown
// inside that answer, as Claude Code's Stop hook keeps the model working in the
// same turn; it never replaces the answer (2026-09-30: replacing swapped the
// deliverables, sources and tables for a short QA report).
function documentDeliveryDispatchOptions(opts = {}) {
  const documentDeliveryRecovery = Boolean(opts.documentDeliveryRecovery);
  return {
    expectedArtifactPaths: normalizeExpectedArtifactPaths(opts.expectedArtifactPaths),
    documentDeliveryRecovery,
    continuesTurnId: documentDeliveryRecovery ? String(opts.continuesTurnId || "") : "",
  };
}

function applyDocumentDeliveryTurnState(state, opts = {}) {
  const delivery = documentDeliveryDispatchOptions(opts);
  state.expectedArtifactPaths = delivery.expectedArtifactPaths;
  state.documentDeliveryRecovery = delivery.documentDeliveryRecovery;
  state.continuesTurnId = delivery.continuesTurnId;
}

function clearDocumentDeliveryTurnState(state) {
  state.expectedArtifactPaths = [];
  state.documentDeliveryRecovery = false;
  state.continuesTurnId = "";
}

// `onlyPending`: a check that continues the answer carries only the files it
// must complete — the others passed and stand in the answer above. Carrying
// every file made the round re-judge files it was told not to touch (they had
// no render THIS round: "页面渲染" missing) and re-list all their cards (2026-09-30).
function prepareDocumentDeliveryRecovery(failure = {}, { onlyPending = false } = {}) {
  const artifacts = failure?.documentDelivery?.artifacts || [];
  const pending = onlyPending ? artifacts.filter((item) => item?.ok !== true) : [];
  const paths = normalizeExpectedArtifactPaths((pending.length ? pending : artifacts).map((item) => item?.path));
  if (!paths.length) return null;
  return {
    paths,
    content: buildDocumentDeliveryRecoveryPrompt(failure.documentDelivery, failure.userText),
  };
}

function documentDeliveryTurnIntelligence(turnIntelligence = {}, recovery = false) {
  if (!recovery) return turnIntelligence;
  const taskContract = turnIntelligence.taskContract || {};
  return {
    ...turnIntelligence,
    taskContract: {
      ...taskContract,
      active: true,
      taskType: "document_work",
      semanticIntent: {
        ...(taskContract.semanticIntent || {}),
        operation: "modify",
        sourceKind: "document",
        outputMode: "artifact",
      },
      evidencePolicy: {
        ...(taskContract.evidencePolicy || {}),
        required: true,
        requiredEvidenceKinds: ["document_output"],
      },
    },
    turnPolicy: {
      ...(turnIntelligence.turnPolicy || {}),
      taskType: "document_work",
      rigor: "grounded",
    },
  };
}

module.exports = {
  applyDocumentDeliveryTurnState,
  clearDocumentDeliveryTurnState,
  documentDeliveryDispatchOptions,
  documentDeliveryTurnIntelligence,
  normalizeExpectedArtifactPaths,
  prepareDocumentDeliveryRecovery,
};
