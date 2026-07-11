"use strict";

const crypto = require("node:crypto");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function entryRevision(entry) {
  const { contentRevision, fetchedAt, ...content } = entry || {};
  return sha256(content);
}

function skillContentRevision(entry, { skillMarkdown = "", manifest = null } = {}) {
  const { contentRevision, fetchedAt, ...content } = entry || {};
  return sha256({
    entry: content,
    skillMarkdown: String(skillMarkdown).replace(/\r\n/g, "\n"),
    manifest,
  });
}

function registryRevision(registry) {
  return sha256({
    schemaVersion: registry?.schemaVersion || 1,
    publisher: registry?.publisher || "",
    categories: registry?.categories || [],
    capabilities: registry?.capabilities || {},
    remoteIndexes: registry?.remoteIndexes || [],
    skills: registry?.skills || [],
  });
}

module.exports = {
  stable,
  entryRevision,
  skillContentRevision,
  registryRevision,
};
