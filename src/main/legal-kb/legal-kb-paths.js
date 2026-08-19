"use strict";

const path = require("node:path");

function legalKnowledgePackRoot(rootDir = "") {
  if (rootDir) return path.resolve(rootDir);
  return require("../config").legalKnowledgePackRoot();
}

function legalKnowledgePackStatePath(rootDir = "") {
  return path.join(legalKnowledgePackRoot(rootDir), "state.json");
}

function legalKnowledgePackVersionPath(version, rootDir = "") {
  const safe = String(version || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(safe)) throw new Error("LEGAL_KB_VERSION_INVALID");
  return path.join(legalKnowledgePackRoot(rootDir), "legal-cn-enterprise", safe);
}

module.exports = {
  legalKnowledgePackRoot,
  legalKnowledgePackStatePath,
  legalKnowledgePackVersionPath,
};
