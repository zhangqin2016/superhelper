"use strict";

const crypto = require("node:crypto");

/**
 * What makes two engine serves the same serve?
 *
 * One `opencode serve` is shared by every conversation whose policy it can
 * honour, so the decision to reuse or to start a second one rests entirely on
 * this signature. Keeping it here, apart from the process lifecycle, means the
 * reuse rule can be read and tested without starting anything: a field added
 * to the signature splits profiles (more engines, more memory), a field left
 * out silently lets one conversation's policy leak into another's.
 */

/** The environment as the serve sees it. */
function processProfileEnv(env = {}) {
  // Legacy Claude guide directories are conversation-scoped, not OpenCode config.
  const profile = { ...env };
  delete profile.CLAUDE_CONFIG_DIR;
  return profile;
}

function envSignature(env = {}) {
  const keys = Object.keys(processProfileEnv(env)).sort();
  const stable = {};
  for (const key of keys) stable[key] = String(env[key] ?? "");
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function serveSignature(opts) {
  return JSON.stringify({
    cmd: opts.serverCommand || "",
    dataDir: opts.dataDir || "",
    cfg: opts.configContent || "",
    env: envSignature(opts.env || {}),
  });
}

/** A stable file-name-safe identity for a serve's config, from its signature. */
function serveIdentity(opts) {
  return crypto.createHash("sha256").update(serveSignature(opts)).digest("hex");
}

/** Parse the "listening on http://host:port" line opencode prints on stdout. */
function parseListeningPort(text) {
  const m = String(text).match(/listening on\s+https?:\/\/([^\s:]+):(\d{2,5})/i);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

module.exports = { envSignature, parseListeningPort, processProfileEnv, serveIdentity, serveSignature };
