import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collectSkillGuideReadEvidence, matchesGuide } = require('../../src/main/skill-read-evidence');

export function parseGuideEvalEvents(output) {
  const events = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const event = JSON.parse(line); if (event && typeof event.type === 'string') events.push(event); }
    catch { /* CLI startup notices may coexist with the JSON stream. */ }
  }
  if (!events.length) throw new Error('No structured engine events; cannot measure guide reads');
  if (events.some(e => e.type === 'error')) throw new Error('Engine error during guide eval');
  const sessions = new Set(events.map(e=>e.sessionID).filter(Boolean));
  if (sessions.size > 1) throw new Error('Mixed engine sessions in guide eval');
  const tools = events.filter(e => e.type === 'tool_use').map(e => ({
    name: e.part?.tool, status: e.part?.state?.status, input: e.part?.state?.input, result: e.part?.state?.output,
  }));
  return {
    text: events.filter(e=>e.type==='text').map(e=>e.part?.text || '').join('\n').trim(),
    guideReadEvidence: collectSkillGuideReadEvidence(tools),
  };
}

export function checkGuideEvalEvidence(testCase, result, skillDirs) {
  if (!testCase.check(result.text)) return false;
  if (!testCase.expectGuideRead) return true;
  return (testCase.acceptedSkillIds || [testCase.skill]).some(id => skillDirs[id] && result.guideReadEvidence.some(read => read.outcome === 'success' && matchesGuide(read.path, skillDirs[id])));
}
