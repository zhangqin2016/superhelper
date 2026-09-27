"use strict";

/**
 * The local legal pack, retired.
 *
 * The legal corpus is served (legal-kb-remote.js) and will not be installed on
 * clients again, but every install that used the legal role before kept its
 * download — 3.4 GB on one machine. The first time a process prepares the
 * served pack, the local copy is removed in the background, once. It is a
 * cache Lily wrote under its own data directory; nothing reads it any more.
 */

const fs = require("node:fs");
const path = require("node:path");

let started = null;

function retireLocalLegalPack({ root, log = console } = {}) {
  if (started) return started;
  started = (async () => {
    let dir = root;
    try { dir = dir || require("./legal-kb-paths").legalKnowledgePackRoot(); } catch { return { ok: false, reason: "no_root" }; }
    const resolved = path.resolve(dir);
    // Only Lily's own legal-kb directory, never something a path points elsewhere.
    if (path.basename(resolved) !== "legal-kb" || !fs.existsSync(resolved)) return { ok: true, removed: false };
    try {
      try { await require("./legal-kb-search").closeAllLegalKnowledgeSearch(); } catch { /* nothing was open */ }
      await fs.promises.rm(resolved, { recursive: true, force: true });
      log.info?.(`[legal-kb] retired the local legal pack at ${resolved}: the corpus is served now`);
      return { ok: true, removed: true };
    } catch (error) {
      log.warn?.(`[legal-kb] could not remove the retired local legal pack at ${resolved}: ${error?.message || error}`);
      return { ok: false, reason: error?.code || "rm_failed" };
    }
  })();
  return started;
}

function resetForTests() { started = null; }

module.exports = { retireLocalLegalPack, resetForTests };
