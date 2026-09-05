"use strict";

const { matchesGuide } = require("./skill-read-evidence");
const counts = () => ({ matched: 0, read: 0, unread: 0, unknown: 0, failed: 0 });
function aggregateSkillUsage(audits = []) {
  const result = { turns: 0, turnsWithCandidates: 0, ...counts(), byMatchKind: { explicit: counts(), token_overlap: counts() }, bySkill: Object.create(null), worst: [], matchedUnreadRate: null, advisory: true };
  for (const audit of audits) {
    if (!audit || !Array.isArray(audit.candidates)) continue;
    result.turns++;
    if (audit.candidates.length) result.turnsWithCandidates++;
    const seen = new Set();
    for (const candidate of audit.candidates) {
      if (!candidate || typeof candidate.id !== "string" || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const evidence = Array.isArray(audit.guideReadEvidence)
        ? audit.guideReadEvidence.filter(read => read && matchesGuide(read.path, candidate.guidePath)) : [];
      const success = evidence.some(read => read.outcome === "success");
      const failed = !success && evidence.some(read => read.outcome === "failed");
      const unknown = !success && !failed && (audit.schemaVersion !== 2 || evidence.some(read => read.outcome === "unknown"));
      const outcome = success ? "read" : unknown ? "unknown" : "unread";
      const kind = candidate.matched === "explicit" ? "explicit" : "token_overlap";
      const perSkill = result.bySkill[candidate.id] ||= counts();
      for (const bucket of [result, result.byMatchKind[kind], perSkill]) {
        bucket.matched++; bucket[outcome]++; if (failed) bucket.failed++;
      }
    }
  }
  const known = result.read + result.unread;
  result.matchedUnreadRate = known ? result.unread / known : null;
  result.worst = Object.entries(result.bySkill).map(([id, stats]) => ({ id, unread: stats.unread })).sort((a,b) => b.unread - a.unread || a.id.localeCompare(b.id));
  return result;
}

module.exports = { aggregateSkillUsage };
