"use strict";

const fs = require("node:fs");
const { installLegalKnowledgePack, readLegalKnowledgePackState } = require("./legal-kb-installer");
const { searchLegalKnowledge, prepareLegalKnowledgeSearch } = require("./legal-kb-search");
const { legalKnowledgePackRoot, legalKnowledgePackVersionPath } = require("./legal-kb-paths");

function installedLegalKnowledgePack(rootDir = "") {
  const record = readLegalKnowledgePackState(rootDir).installed?.["legal-cn-enterprise"];
  const packPath = record?.path || (record?.version ? legalKnowledgePackVersionPath(record.version, rootDir) : "");
  if (!packPath || !fs.existsSync(packPath)) return null;
  return { ...record, path: packPath };
}

async function ensureLegalKnowledgePack(options = {}) {
  const installed = await installLegalKnowledgePack(options);
  if (!installed.ok) return installed;
  try {
    await prepareLegalKnowledgeSearch(installed.path, options.onProgress);
    return { ...installed, indexed: true };
  } catch (error) {
    return { ok: false, error: error?.message || "LEGAL_KB_INDEX_FAILED", path: installed.path };
  }
}

async function search(args = {}, options = {}) {
  let installed = installedLegalKnowledgePack(options.rootDir || "");
  if (!installed && options.autoInstall !== false) {
    const install = await ensureLegalKnowledgePack(options);
    if (!install.ok) return { ok: false, error: install.error, previousPath: install.previousPath || "", results: [] };
    installed = { version: install.version, path: install.path };
  }
  if (!installed) return { ok: false, error: "LEGAL_KB_NOT_READY", results: [] };
  return searchLegalKnowledge({ ...args, packPath: installed.path, onProgress: options.onProgress });
}

function status(rootDir = "") {
  const installed = installedLegalKnowledgePack(rootDir);
  return {
    ok: true,
    packId: "legal-cn-enterprise",
    installed: Boolean(installed),
    version: installed?.version || "",
    path: installed?.path || legalKnowledgePackRoot(rootDir),
  };
}

module.exports = { ensureLegalKnowledgePack, installedLegalKnowledgePack, search, status };
