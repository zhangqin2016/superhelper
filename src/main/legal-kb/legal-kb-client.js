"use strict";

function createLegalKnowledgePackArtifact({ serviceFetch, getDeviceId }) {
  return function legalKnowledgePackArtifact(characterId) {
    return serviceFetch("/api/legal-kb/artifact", {
      method: "POST",
      body: JSON.stringify({
        deviceId: getDeviceId(),
        characterId: String(characterId || "lily-cn-legal-counsel"),
      }),
    });
  };
}

async function legalKnowledgePackArtifact(characterId) {
  const serviceClient = require("../service-client");
  return serviceClient.serviceFetch("/api/legal-kb/artifact", {
    method: "POST",
    body: JSON.stringify({
      deviceId: serviceClient.getDeviceId(),
      characterId: String(characterId || "lily-cn-legal-counsel"),
    }),
  });
}

module.exports = { createLegalKnowledgePackArtifact, legalKnowledgePackArtifact };
