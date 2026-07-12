#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
if (!args.events || !args.metadata || !args.output) {
  console.error('usage: node scripts/score-mobile-asr-evidence.mjs --events events.ndjson --metadata metadata.json --output raw-metrics.json');
  process.exit(2);
}

const metadata = JSON.parse(await readFile(args.metadata, 'utf8'));
const eventBytes = await readFile(args.events);
const rows = eventBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch (error) { throw new Error(`invalid NDJSON row ${index + 1}: ${error.message}`); }
});
const scored = rows.filter((row) => !row.excluded);
if (!scored.length) throw new Error('no scored event rows');
for (const row of scored) {
  if (row.resources.rssPeakMiB < row.resources.rssBaselineMiB) throw new Error(`${row.eventId}: rssPeakMiB is below rssBaselineMiB`);
}

const seed = metadata.scorer?.bootstrapSeed ?? 20260712;
const iterations = metadata.scorer?.bootstrapIterations ?? 10000;
const rng = mulberry32(seed);
const strata = Map.groupBy(scored, (row) => row.caseId.split('.').slice(0, 4).join('.'));
const samples = Array.from({ length: iterations }, () => Array.from(strata.values()).flatMap((group) =>
  Array.from({ length: group.length }, () => group[Math.floor(rng() * group.length)])));

const estimate = (fn, unit) => {
  const point = finite(fn(scored));
  const bootstrap = samples.map(fn).map(finite).sort((a, b) => a - b);
  return { point, lower95: percentile(bootstrap, 0.025), upper95: percentile(bootstrap, 0.975), unit, n: scored.length };
};
const medianOf = (getter) => (data) => percentile(data.map(getter).sort((a, b) => a - b), 0.5);
const quantileOf = (getter, q) => (data) => percentile(data.map(getter).sort((a, b) => a - b), q);
const meanOf = (getter) => (data) => data.reduce((sum, row) => sum + getter(row), 0) / data.length;
const firstPartial = (row) => row.timestamps.firstPartialMs - row.timestamps.audioStartMs;
const finalAfterStop = (row) => row.timestamps.finalMs - row.timestamps.audioStopMs;
const edits = (reference, hypothesis, tokens) => levenshtein(tokens(normalize(reference)), tokens(normalize(hypothesis))) / Math.max(1, tokens(normalize(reference)).length);
const words = (text) => text.split(/\s+/).filter(Boolean);
const characters = (text) => [...text.replace(/\s+/g, '')];
const exactObject = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const usable = (row) => Number(row.referenceIntent === row.hypothesisIntent && exactObject(row.slotsExpected, row.slotsObserved));
const slotExact = (row) => Number(exactObject(row.slotsExpected, row.slotsObserved));
const keyTermExact = (row) => row.keyTermsExpected.length
  ? row.keyTermsExpected.filter((term) => row.keyTermsObserved.includes(term)).length / row.keyTermsExpected.length : 1;
const flicker = (row) => {
  const revisions = row.partialRevisions;
  let rewrites = 0;
  for (let i = 1; i < revisions.length; i += 1) if (!revisions[i].text.startsWith(revisions[i - 1].text)) rewrites += 1;
  const seconds = Math.max(0.001, (row.timestamps.audioStopMs - row.timestamps.audioStartMs) / 1000);
  return rewrites * 10 / seconds;
};
const revisionViolation = (row) => Number(row.partialRevisions.some((revision, index, revisions) => index > 0 && revision.revisionId <= revisions[index - 1].revisionId));
const rssDelta = (row) => row.resources.rssPeakMiB - row.resources.rssBaselineMiB;
const battery30 = (row) => (row.resources.batteryStartPercent - row.resources.batteryEndPercent) * 30 / row.resources.measurementMinutes;

const result = {
  schemaVersion: '1.1.0', runId: metadata.runId, status: 'complete', startedAt: metadata.startedAt,
  owner: metadata.owner, scorer: metadata.scorer, corpus: metadata.corpus,
  candidate: scored[0].candidate, device: scored[0].device, app: scored[0].app, networkProfile: scored[0].network,
  sampleCounts: { attempted: rows.length, scored: scored.length, excluded: rows.length - scored.length },
  latencyMs: {
    firstPartial: { p50: estimate(quantileOf(firstPartial, 0.5), 'ms'), p95: estimate(quantileOf(firstPartial, 0.95), 'ms') },
    finalAfterStop: { p50: estimate(quantileOf(finalAfterStop, 0.5), 'ms'), p95: estimate(quantileOf(finalAfterStop, 0.95), 'ms') },
  },
  accuracy: {
    wer: estimate(meanOf((row) => edits(row.reference, row.hypothesis, words)), 'ratio'),
    cer: estimate(meanOf((row) => edits(row.reference, row.hypothesis, characters)), 'ratio'),
    usableCommandRate: estimate(meanOf(usable), 'ratio'),
    slotExactRate: estimate(meanOf(slotExact), 'ratio'),
    mixedKeyTermExactRate: estimate(meanOf(keyTermExact), 'ratio'),
  },
  stability: {
    flickerRewritesPer10s: estimate(meanOf(flicker), 'rewrites/10s'),
    monotonicRevisionViolationRate: estimate(meanOf(revisionViolation), 'ratio'),
  },
  resources: {
    cpuAveragePercent: estimate(meanOf((row) => row.resources.cpuAveragePercent), 'percent'),
    rssDeltaPeakMiB: estimate(medianOf(rssDelta), 'MiB'),
    batteryDeltaPercentPer30Min: estimate(meanOf(battery30), 'percentage-points/30min'),
  },
  network: {
    bytesSent: estimate(meanOf((row) => row.resources.networkBytesSent), 'bytes/utterance'),
    bytesReceived: estimate(meanOf((row) => row.resources.networkBytesReceived), 'bytes/utterance'),
  },
  cost: { total: estimate((data) => data.reduce((sum, row) => sum + row.resources.cost, 0), scored[0].resources.currency) },
  reliability: {
    successfulFinalRate: estimate(meanOf((row) => Number(row.errors.length === 0 && row.partialRevisions.some((revision) => revision.final))), 'ratio'),
    draftPreservationRate: estimate(meanOf((row) => Number(row.draftPreserved)), 'ratio'),
    crashRate: estimate(meanOf((row) => Number(row.errors.some((error) => error.code === 'CRASH'))), 'ratio'),
  },
  acceptance: {},
  privacy: metadata.privacyCost,
  artifacts: [...metadata.artifacts.filter((artifact) => artifact.kind !== 'events'), { kind: 'events', path: args.events, sha256: createHash('sha256').update(eventBytes).digest('hex') }],
};

result.acceptance.rssDeltaPeakMiB = gate(result.resources.rssDeltaPeakMiB, 100, 'upper');
result.acceptance.firstPartialP50 = gate(result.latencyMs.firstPartial.p50, 350, 'upper');
result.acceptance.firstPartialP95 = gate(result.latencyMs.firstPartial.p95, 600, 'upper');
result.acceptance.finalAfterStopP50 = gate(result.latencyMs.finalAfterStop.p50, 800, 'upper');
result.acceptance.finalAfterStopP95 = gate(result.latencyMs.finalAfterStop.p95, 1200, 'upper');
result.acceptance.usableCommandRate = gate(result.accuracy.usableCommandRate, 0.95, 'lower');
result.acceptance.mixedKeyTermExactRate = gate(result.accuracy.mixedKeyTermExactRate, 0.95, 'lower');
result.acceptance.flickerRewritesPer10s = gate(result.stability.flickerRewritesPer10s, 2, 'upper');
result.acceptance.monotonicRevisionViolationRate = gate(result.stability.monotonicRevisionViolationRate, 0, 'upper');
result.acceptance.cpuAveragePercent = gate(result.resources.cpuAveragePercent, 20, 'upper');
result.acceptance.batteryDeltaPercentPer30Min = gate(result.resources.batteryDeltaPercentPer30Min, 3, 'upper');
result.acceptance.successfulFinalRate = gate(result.reliability.successfulFinalRate, 0.99, 'lower');
result.acceptance.draftPreservationRate = gate(result.reliability.draftPreservationRate, 1, 'lower');
result.acceptance.crashRate = gate(result.reliability.crashRate, 0, 'upper');

await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);

function gate(metric, threshold, bound) {
  return { threshold, bound, conservativePass: bound === 'upper' ? metric.upper95 <= threshold : metric.lower95 >= threshold };
}
function normalize(value) { return value.normalize('NFC').toLowerCase(); }
function levenshtein(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = current;
  }
  return previous[b.length];
}
function percentile(sorted, q) { return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]; }
function finite(value) { if (!Number.isFinite(value)) throw new Error(`non-finite metric: ${value}`); return value; }
function mulberry32(value) { return () => { value |= 0; value = value + 0x6D2B79F5 | 0; let t = Math.imul(value ^ value >>> 15, 1 | value); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
