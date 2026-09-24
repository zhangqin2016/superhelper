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

// Installed AND entitled — the one answer every reader of the pack uses
// (turn preparation, the search tool). See legal-kb-entitlement.
function usableLegalKnowledgePack(rootDir = "") {
  const installed = installedLegalKnowledgePack(rootDir);
  if (!installed) return { pack: null, code: "LEGAL_KB_NOT_READY" };
  const { allowed, code } = require("./legal-kb-entitlement").entitlementAllows(readLegalKnowledgePackState(rootDir).entitlement);
  return allowed ? { pack: installed } : { pack: null, code };
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
  const usable = usableLegalKnowledgePack(options.rootDir || "");
  let installed = usable.pack;
  // A refused or expired entitlement is an answer, not a missing install.
  if (!installed && usable.code !== "LEGAL_KB_NOT_READY") return { ok: false, error: usable.code, results: [] };
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
  const usable = usableLegalKnowledgePack(rootDir);
  return {
    ok: true,
    packId: "legal-cn-enterprise",
    installed: Boolean(installed),
    usable: Boolean(usable.pack),
    ...(usable.pack ? {} : { unusableCode: usable.code }),
    version: installed?.version || "",
    path: installed?.path || legalKnowledgePackRoot(rootDir),
  };
}

module.exports = { ensureLegalKnowledgePack, installedLegalKnowledgePack, usableLegalKnowledgePack, search, status };
