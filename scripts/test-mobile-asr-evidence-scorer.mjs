import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(tmpdir(), 'lily-asr-scorer-'));
const hash = 'a'.repeat(64);
const schemaPath = path.join(root, 'docs/evidence/mobile-command/asr/event-row.schema.json');
const environments = ['quiet', 'street', 'headset', 'far-field'];
const languages = ['zh-CN', 'en-US', 'mixed'];
const lengths = ['short', 'long'];
const intents = ['ordinary', 'sensitive'];
const cells = environments.flatMap((environment) =>
  languages.flatMap((language) =>
    lengths.flatMap((length) =>
      intents.map((intent) => ({ environment, language, length, intent }))
    )
  )
);

function row(index, cell, os) {
  const finalOk = index !== 0;
  return {
    schemaVersion: '1.1.0', eventId: `event-${os}-${index}`,
    caseId: `${cell.environment}.${cell.language}.${cell.length}.${cell.intent}.${String(index + 1).padStart(3, '0')}`,
    candidate: { provider: 'local-test', model: 'fixture', modelVersion: '1', region: 'device', endpointClass: 'on-device' },
    device: { deviceId: `${os.toLowerCase()}-device`, manufacturer: 'Test', model: 'Fixture', os, osVersion: '1' },
    app: { name: 'Lily Test', version: '1.0.0', build: '1' },
    network: { profile: Math.floor(index / 2) % 2 ? 'connected' : 'offline', downKbps: 1000, upKbps: 500, rttMs: 20, packetLossPercent: 0 },
    environment: cell.environment, noiseProfile: `controlled-${cell.environment}`, language: cell.language,
    captureMode: Math.floor(index / 4) % 2 ? 'foreground' : 'background',
    audioSha256: hash, consentRef: 'consent-fixture',
    timestamps: { audioStartMs: 1000, audioStopMs: 11000, firstPartialMs: 1200, finalMs: 11500 },
    partialRevisions: [
      { revisionId: 1, atMs: 1200, tokens: ['open', 'rep'], activeTrailingStart: 1, final: false },
      { revisionId: 2, atMs: 1300, tokens: [index === 1 ? 'close' : 'open', 'report'], activeTrailingStart: 1, final: false },
      { revisionId: 3, atMs: 11500, tokens: ['open', 'report'], activeTrailingStart: 2, final: true }
    ],
    reference: 'open report', hypothesis: finalOk ? 'open report' : 'close report',
    referenceIntent: 'open-file', hypothesisIntent: finalOk ? 'open-file' : 'close-file',
    slotsExpected: { file: 'report' }, slotsObserved: finalOk ? { file: 'report' } : { file: 'other' },
    keyTermsExpected: cell.language === 'mixed' ? ['report', 'Lily'] : [], keyTermsObserved: cell.language === 'mixed' ? ['report', 'Lily'] : [],
    errors: [], excluded: false, draftPreserved: finalOk,
    resources: { cpuBaselinePercent: 2, cpuAveragePercent: 12, cpuPeakPercent: 30, rssBaselineMiB: 100, rssPeakMiB: 180, batteryStartPercent: 80, batteryEndPercent: 79, measurementMinutes: 30, networkBytesSent: 10, networkBytesReceived: 20, billableAudioSeconds: 10, cost: 0.01, currency: 'USD' }
  };
}

async function writeRun(name, rowsByFile) {
  const paths = [];
  for (let i = 0; i < rowsByFile.length; i += 1) {
    const file = path.join(temp, `${name}-${i}.ndjson`);
    const bytes = `${rowsByFile[i].map(JSON.stringify).join('\n')}\n`;
    await writeFile(file, bytes);
    paths.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex'), deviceId: rowsByFile[i][0].device.deviceId });
  }
  const metadataPath = path.join(temp, `${name}-metadata.json`);
  await writeFile(metadataPath, JSON.stringify({ runId: '20260712T120000Z_aaaaaaaaaaaa', startedAt: '2026-07-12T12:00:00Z', owner: 'Mobile Command / ASR DRI', scorer: { version: '1.1.0', commit: 'fixture-commit', bootstrapSeed: 20260712, bootstrapIterations: 100 }, corpus: { id: 'fixture-corpus', version: '1', path: 'external/fixture', sha256: hash }, inputArtifacts: paths, artifacts: [], privacyCost: { audioRetention: 'none', transcriptRetention: 'test-only', logging: 'none', credentialOwner: 'test' } }));
  return { paths, metadataPath };
}

function invoke(run, output) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/score-mobile-asr-evidence.mjs'), ...run.paths.flatMap((item) => ['--events', item.path]), '--metadata', run.metadataPath, '--event-schema', schemaPath, '--output', output], { cwd: root, encoding: 'utf8' });
}

const small = await writeRun('small', [[row(0, cells[0], 'iOS')], [row(1, cells[1], 'Android')]]);
const smallOutput = path.join(temp, 'small.json');
assert.equal(invoke(small, smallOutput).status, 0);
const blocked = JSON.parse(await readFile(smallOutput, 'utf8'));
assert.equal(blocked.status, 'blocked');
assert.ok(blocked.missingInputs.some((item) => item.includes('500')));
assert.equal(blocked.acceptance, undefined, 'blocked runs must not publish acceptance passes');

const ios = [];
const android = [];
for (const [cellIndex, cell] of cells.entries()) for (let n = 0; n < 21; n += 1) {
  const target = n % 2 ? ios : android;
  const event = row(cellIndex * 21 + n, cell, n % 2 ? 'iOS' : 'Android');
  if (cellIndex === 0 && n === 0) { event.excluded = true; event.exclusionReason = 'predeclared capture corruption'; event.draftPreserved = true; }
  target.push(event);
}
const completeRun = await writeRun('complete', [ios, android]);
const outputA = path.join(temp, 'complete-a.json');
const outputB = path.join(temp, 'complete-b.json');
assert.equal(invoke(completeRun, outputA).status, 0);
assert.equal(invoke(completeRun, outputB).status, 0);
const a = JSON.parse(await readFile(outputA, 'utf8'));
const b = JSON.parse(await readFile(outputB, 'utf8'));
assert.deepEqual(a, b);
assert.equal(a.status, 'complete');
assert.equal(a.devices.length, 2);

const expected = wilson(1007, 1007);
assert.deepEqual(a.sampleCounts, { attempted: 1008, scored: 1007, excluded: 1 });
assert.equal(a.accuracy.usableCommandRate.n, 1007);
assert.ok(Math.abs(a.accuracy.usableCommandRate.lower95 - expected.lower) < 1e-12);
assert.ok(Math.abs(a.accuracy.usableCommandRate.upper95 - expected.upper) < 1e-12);
assert.notEqual(a.accuracy.usableCommandRate.lower95, a.accuracy.wer.lower95, 'Wilson and bootstrap intervals must be distinct methods');
assert.equal(a.reliability.draftPreservationRate.n, 1008, 'attempted rows are the denominator');
assert.equal(a.reliability.successfulFinalRate.n, 1008, 'excluded/errors still count in successful-final denominator');
assert.equal(a.reliability.successfulFinalRate.point, 1007 / 1008);
assert.ok(a.reliability.draftPreservationRate.lower95 < 1, 'Wilson interval is still reported for an all-success proportion');
assert.equal(a.acceptance.draftPreservation.conservativePass, true, 'draft safety passes on exact zero failures, not Wilson lower bound');
assert.deepEqual(a.reliability.draftPreservationFailures, { count: 0, n: 1008 });
assert.equal(a.acceptance.crashes.conservativePass, true);
assert.equal(a.acceptance.revisionOrderViolations.conservativePass, true);
assert.equal(a.overallAcceptancePass, true);
assert.equal(a.accuracy.mixedKeyTermExactRate.n, 672, 'mixed key-term interval uses annotated terms as micro denominator');
assert.equal(a.stability.flickerRewritesPer10s.point > 0, true, 'only stable-prefix token changes flicker');

const oneViolationIos = structuredClone(ios);
oneViolationIos[0].partialRevisions[1].revisionId = 1;
oneViolationIos[0].errors = [{ code: 'CRASH', message: 'synthetic test failure' }];
oneViolationIos[0].draftPreserved = false;
const unsafeRun = await writeRun('unsafe', [oneViolationIos, android]);
const unsafeOutput = path.join(temp, 'unsafe.json');
assert.equal(invoke(unsafeRun, unsafeOutput).status, 0);
const unsafe = JSON.parse(await readFile(unsafeOutput, 'utf8'));
assert.equal(unsafe.status, 'complete');
assert.equal(unsafe.acceptance.revisionOrderViolations.conservativePass, false);
assert.equal(unsafe.acceptance.crashes.conservativePass, false);
assert.equal(unsafe.acceptance.draftPreservation.conservativePass, false);
assert.equal(unsafe.overallAcceptancePass, false);
assert.deepEqual(unsafe.stability.revisionOrderViolations, { count: 1, n: 1007 });

const imbalancedRows = [...ios, ...android].map((event, index) => ({ ...structuredClone(event), device: { ...event.device, deviceId: index === 0 ? 'android-only' : 'ios-heavy', os: index === 0 ? 'Android' : 'iOS' } }));
const imbalanced = await writeRun('imbalanced', [[imbalancedRows[0]], imbalancedRows.slice(1)]);
const imbalancedOutput = path.join(temp, 'imbalanced.json');
assert.equal(invoke(imbalanced, imbalancedOutput).status, 0);
const imbalancedResult = JSON.parse(await readFile(imbalancedOutput, 'utf8'));
assert.equal(imbalancedResult.status, 'blocked');
assert.ok(imbalancedResult.missingInputs.some((item) => item.includes('Android') && item.includes('250')));

const noStrataRows = [...ios, ...android].map((event) => ({ ...structuredClone(event), network: { ...event.network, profile: 'connected' }, captureMode: 'foreground' }));
const noStrata = await writeRun('no-strata', [noStrataRows.filter((r) => r.device.os === 'iOS'), noStrataRows.filter((r) => r.device.os === 'Android')]);
const noStrataOutput = path.join(temp, 'no-strata.json');
assert.equal(invoke(noStrata, noStrataOutput).status, 0);
const noStrataResult = JSON.parse(await readFile(noStrataOutput, 'utf8'));
assert.equal(noStrataResult.status, 'blocked');
assert.ok(noStrataResult.missingInputs.some((item) => item.includes('offline') && item.includes('50')));
assert.ok(noStrataResult.missingInputs.some((item) => item.includes('background') && item.includes('50')));

const invalidRows = [[{ ...row(0, cells[0], 'iOS'), unexpected: true }], [row(1, cells[1], 'Android')]];
const invalid = await writeRun('invalid', invalidRows);
assert.notEqual(invoke(invalid, path.join(temp, 'invalid.json')).status, 0, 'runtime schema validation must reject additional properties');

const mixedRows = [[row(0, cells[0], 'iOS')], [{ ...row(1, cells[1], 'Android'), candidate: { ...row(1, cells[1], 'Android').candidate, provider: 'other' } }]];
const mixed = await writeRun('mixed-provider', mixedRows);
assert.notEqual(invoke(mixed, path.join(temp, 'mixed.json')).status, 0, 'candidate homogeneity is mandatory');

function wilson(success, n) {
  const z = 1.959963984540054;
  const p = success / n;
  const d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { lower: center - margin, upper: center + margin };
}

console.log('mobile ASR evidence scorer tests passed');
