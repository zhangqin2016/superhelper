"use strict";

const { buildDocumentDeliveryRecoveryPrompt } = require("./document-delivery-gate");

function normalizeExpectedArtifactPaths(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function documentDeliveryDispatchOptions(opts = {}) {
  return {
    expectedArtifactPaths: normalizeExpectedArtifactPaths(opts.expectedArtifactPaths),
    documentDeliveryRecovery: Boolean(opts.documentDeliveryRecovery),
  };
}

function applyDocumentDeliveryTurnState(state, opts = {}) {
  const delivery = documentDeliveryDispatchOptions(opts);
  state.expectedArtifactPaths = delivery.expectedArtifactPaths;
  state.documentDeliveryRecovery = delivery.documentDeliveryRecovery;
}

function clearDocumentDeliveryTurnState(state) {
  state.expectedArtifactPaths = [];
  state.documentDeliveryRecovery = false;
}

function prepareDocumentDeliveryRecovery(failure = {}) {
  const paths = normalizeExpectedArtifactPaths(
    (failure?.documentDelivery?.artifacts || []).map((item) => item?.path),
  );
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
