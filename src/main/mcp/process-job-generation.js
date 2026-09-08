"use strict";

function sameJobGeneration(current, expected) {
  if (!current) return false;
  if (current.generationId || expected.generationId) return current.generationId === expected.generationId;
  return current.pid === expected.pid && current.startedAt === expected.startedAt;
}

function createJobGenerationGuard({ readRegistry, writeRegistry }) {
  function updateJobGeneration(expected, update, options) {
    const latest = readRegistry(options);
    const current = latest.jobs[expected.jobId];
    if (!sameJobGeneration(current, expected)) return null;
    const observed = update(current);
    latest.jobs[expected.jobId] = observed;
    writeRegistry(latest, options);
    return observed;
  }
  return { sameJobGeneration, updateJobGeneration };
}

module.exports = { createJobGenerationGuard };
