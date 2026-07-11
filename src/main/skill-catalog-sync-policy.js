"use strict";

const fs = require("node:fs");
const path = require("node:path");

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeExternalEntries(currentRegistry, externalEntries, options = {}) {
  const allowedIdPrefixes = Array.isArray(options.allowedIdPrefixes) ? options.allowedIdPrefixes : [];
  const allowAdditions = options.allowAdditions === true;
  const next = deepClone(currentRegistry);
  const byId = new Map((next.skills || []).map((skill) => [skill.id, skill]));
  const seen = new Set();

  for (const incoming of Array.isArray(externalEntries) ? externalEntries : []) {
    const id = String(incoming?.id || "");
    if (!id || !allowedIdPrefixes.some((prefix) => id.startsWith(prefix))) {
      throw new Error(`External skill id is outside its allowed namespace: ${id || "<empty>"}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate external skill id: ${id}`);
    seen.add(id);
    const existing = byId.get(id);
    if (!existing && !allowAdditions) continue;
    byId.set(id, {
      ...(existing || {}),
      ...deepClone(incoming),
      id,
      sourceKind: existing?.sourceKind || incoming.sourceKind || "bundled-vendor",
    });
  }

  next.skills = Array.from(byId.values());
  return next;
}

function validateCandidate(candidate, baseline) {
  const errors = [];
  if (candidate?.schemaVersion !== 1 || !Array.isArray(candidate?.skills)) {
    return { ok: false, errors: ["invalid registry schema"] };
  }
  const candidateIds = candidate.skills.map((skill) => String(skill?.id || ""));
  const uniqueIds = new Set(candidateIds);
  if (uniqueIds.size !== candidateIds.length) errors.push("duplicate skill ids");

  const allowedCategories = new Set((candidate.categories || []).map((category) => category.id));
  for (const skill of candidate.skills) {
    if (!skill.id) errors.push("skill without id");
    if (skill.category && !allowedCategories.has(skill.category)) {
      errors.push(`${skill.id} uses undeclared category ${skill.category}`);
    }
  }

  const candidateById = new Map(candidate.skills.map((skill) => [skill.id, skill]));
  for (const baselineSkill of baseline?.skills || []) {
    if (!baselineSkill.id?.startsWith("lily-")) continue;
    const current = candidateById.get(baselineSkill.id);
    if (!current) {
      errors.push(`required first-party skill removed: ${baselineSkill.id}`);
      continue;
    }
    if (JSON.stringify(current) !== JSON.stringify(baselineSkill)) {
      errors.push(`first-party skill changed by external sync: ${baselineSkill.id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function writeJsonAtomically(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, targetPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

module.exports = {
  mergeExternalEntries,
  validateCandidate,
  writeJsonAtomically,
};
