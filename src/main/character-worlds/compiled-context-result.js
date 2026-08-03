"use strict";

const crypto = require("node:crypto");
const { compileRoleActivationContract } = require("./role-activation-contract");
const { stableJson } = require("./persistence-codec");

function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function buildCompiledContextResult(input) {
  const fingerprint = sha256(input.text);
  const activationContract = input.characterMode
    ? compileRoleActivationContract({
        role: { revisionId: input.revisionId, name: input.name },
        expressionProfile: input.expressionProfile,
        narrativeFingerprint: fingerprint,
      })
    : null;
  if (input.characterMode && !activationContract) return null;
  const worldBook = input.worldResolution
    ? {
        revisionId: input.worldBookRevisionId,
        revisionHash: input.worldResolution.trace.revisionHash,
        nextCheckpoint: input.worldResolution.nextCheckpoint,
        activationFingerprint: sha256(stableJson({
          revisionHash: input.worldResolution.trace.revisionHash,
          activated: input.activatedWorldEntries,
          checkpoint: input.worldResolution.nextCheckpoint,
        })),
      }
    : null;
  return {
    schemaVersion: input.schemaVersion,
    status: "compiled",
    text: input.text,
    fingerprint,
    ...(activationContract ? { activationContract } : {}),
    tokenEstimate: input.tokenEstimate,
    omitted: input.omitted,
    warnings: input.warnings,
    activatedFields: input.activatedFields,
    activatedWorldEntries: input.activatedWorldEntries,
    safeBehaviors: input.safeBehaviors,
    expressionProfile: input.expressionProfile,
    persona: input.personaBlock
      ? { revisionId: input.personaBlock.sourceRevision, fingerprint: input.personaBlock.contentHash }
      : null,
    worldBook,
  };
}

module.exports = { buildCompiledContextResult };
