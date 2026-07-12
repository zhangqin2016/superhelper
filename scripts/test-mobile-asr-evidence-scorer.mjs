import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'lily-asr-scorer-'));
const eventsPath = path.join(temp, 'events.ndjson');
const metadataPath = path.join(temp, 'metadata.json');
const outputA = path.join(temp, 'metrics-a.json');
const outputB = path.join(temp, 'metrics-b.json');
const hash = 'a'.repeat(64);

const base = {
  schemaVersion: '1.0.0',
  candidate: { provider: 'local-test', model: 'fixture', modelVersion: '1', region: 'device', endpointClass: 'on-device' },
  device: { deviceId: 'test-device', manufacturer: 'Test', model: 'Fixture', os: 'Android', osVersion: '1' },
  app: { name: 'Lily Test', version: '1.0.0', build: '1' },
  network: { profile: 'offline', downKbps: 0, upKbps: 0, rttMs: 0, packetLossPercent: 0 },
  audioSha256: hash,
  consentRef: 'consent-fixture',
  language: 'en-US',
  noiseProfile: 'controlled-quiet',
  referenceIntent: 'open-file',
  hypothesisIntent: 'open-file',
  slotsExpected: { file: 'report' },
  slotsObserved: { file: 'report' },
  keyTermsExpected: ['report'],
  keyTermsObserved: ['report'],
  errors: [],
  excluded: false,
  draftPreserved: true,
};

const events = Array.from({ length: 16 }, (_, index) => {
  const environment = 'quiet';
  const locale = 'mixed';
  const length = 'short';
  const intent = 'ordinary';
  const audioStartMs = 1_000;
  const audioStopMs = 11_000;
  return {
    ...base,
    eventId: `event-${index}`,
    caseId: `${environment}.${locale}.${length}.${intent}.${String(index + 1).padStart(3, '0')}`,
    environment,
    language: locale,
    timestamps: { audioStartMs, audioStopMs, firstPartialMs: audioStartMs + 200 + index, finalMs: audioStopMs + 500 + index },
    partialRevisions: [
      { revisionId: 1, atMs: audioStartMs + 200, text: 'open', final: false },
      { revisionId: 2, atMs: audioStartMs + 300, text: index === 0 ? 'other' : 'open report', final: false },
      { revisionId: 3, atMs: audioStopMs + 500, text: 'open report', final: true },
    ],
    reference: 'open report',
    hypothesis: index === 1 ? 'open reports' : 'open report',
    resources: {
      cpuBaselinePercent: 2,
      cpuAveragePercent: 12 + index / 10,
      cpuPeakPercent: 30,
      rssBaselineMiB: 100,
      rssPeakMiB: index >= 9 ? 230 : 180,
      batteryStartPercent: 80,
      batteryEndPercent: 79,
      measurementMinutes: 30,
      networkBytesSent: index * 10,
      networkBytesReceived: index * 20,
      billableAudioSeconds: 10,
      cost: 0.01,
      currency: 'USD'
    }
  };
});

await writeFile(eventsPath, `${events.map((row) => JSON.stringify(row)).join('\n')}\n`);
await writeFile(metadataPath, JSON.stringify({
  runId: '20260712T120000Z_aaaaaaaaaaaa',
  startedAt: '2026-07-12T12:00:00Z',
  owner: 'Mobile Command / ASR DRI',
  scorer: { version: '1.0.0', commit: 'fixture-commit', bootstrapSeed: 20260712, bootstrapIterations: 200 },
  corpus: { id: 'fixture-corpus', version: '1', path: 'external/fixture', sha256: hash },
  artifacts: [{ kind: 'events', path: 'events.ndjson', sha256: hash }],
  privacyCost: { audioRetention: 'none', transcriptRetention: 'test-only', logging: 'none', credentialOwner: 'test' }
}));

function run(output) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/score-mobile-asr-evidence.mjs'),
    '--events', eventsPath,
    '--metadata', metadataPath,
    '--output', output,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

run(outputA);
run(outputB);
const a = JSON.parse(await readFile(outputA, 'utf8'));
const b = JSON.parse(await readFile(outputB, 'utf8'));

const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
const draft6Compatible = async (file) => JSON.parse(
  (await readFile(path.join(root, file), 'utf8'))
    .replace('"$schema": "https://json-schema.org/draft/2020-12/schema",', '')
    .replaceAll('"$defs"', '"definitions"')
    .replaceAll('#/$defs/', '#/definitions/')
);
const validateEvent = ajv.compile(await draft6Compatible('docs/evidence/mobile-command/asr/event-row.schema.json'));
for (const event of events) assert.equal(validateEvent(event), true, ajv.errorsText(validateEvent.errors));
const validateMetrics = ajv.compile(await draft6Compatible('docs/evidence/mobile-command/asr/raw-metrics.schema.json'));
assert.equal(validateMetrics(a), true, ajv.errorsText(validateMetrics.errors));

assert.deepEqual(a, b, 'fixed-seed scoring must be byte-semantically deterministic');
assert.equal(a.status, 'complete');
assert.deepEqual(a.sampleCounts, { attempted: 16, scored: 16, excluded: 0 });

for (const metric of [
  a.latencyMs.firstPartial.p50, a.latencyMs.firstPartial.p95,
  a.latencyMs.finalAfterStop.p50, a.latencyMs.finalAfterStop.p95,
  a.accuracy.wer, a.accuracy.cer, a.accuracy.usableCommandRate,
  a.accuracy.slotExactRate, a.accuracy.mixedKeyTermExactRate,
  a.stability.flickerRewritesPer10s, a.stability.monotonicRevisionViolationRate, a.resources.cpuAveragePercent,
  a.resources.rssDeltaPeakMiB, a.resources.batteryDeltaPercentPer30Min,
  a.network.bytesSent, a.network.bytesReceived, a.cost.total,
  a.reliability.successfulFinalRate, a.reliability.draftPreservationRate, a.reliability.crashRate,
]) {
  assert.deepEqual(Object.keys(metric).sort(), ['lower95', 'n', 'point', 'unit', 'upper95']);
  assert.ok(metric.lower95 <= metric.point && metric.point <= metric.upper95);
}

assert.equal(a.resources.rssDeltaPeakMiB.point, 80, 'RSS point must use per-row peak minus baseline, then median');
assert.equal(a.acceptance.rssDeltaPeakMiB.threshold, 100);
assert.equal(a.acceptance.rssDeltaPeakMiB.conservativePass, false, 'upper CI above 100 must fail the conservative gate');
assert.equal(a.scorer.bootstrapSeed, 20260712);

console.log('mobile ASR evidence scorer tests passed');
