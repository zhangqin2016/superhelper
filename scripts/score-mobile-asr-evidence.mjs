#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv-formats/node_modules/ajv/dist/2020').default;
const args = parseArgs(process.argv.slice(2));
if (!args.events?.length || !args.metadata || !args.output) {
  console.error('usage: node scripts/score-mobile-asr-evidence.mjs --events ios.ndjson --events android.ndjson --metadata metadata.json --event-schema event-row.schema.json --output raw-metrics.json');
  process.exit(2);
}

const metadata = JSON.parse(await readFile(args.metadata, 'utf8'));
const eventSchemaPath = args['event-schema'] || path.resolve('docs/evidence/mobile-command/asr/event-row.schema.json');
const metricsSchemaPath = path.resolve('docs/evidence/mobile-command/asr/raw-metrics.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateEvent = ajv.compile(JSON.parse(await readFile(eventSchemaPath, 'utf8')));
const validateMetrics = ajv.compile(JSON.parse(await readFile(metricsSchemaPath, 'utf8')));
const rows = [];
const inputArtifacts = [];

for (const file of args.events) {
  const bytes = await readFile(file);
  const expected = metadata.inputArtifacts?.find((item) => path.resolve(item.path) === path.resolve(file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!expected || expected.sha256 !== sha256) throw new Error(`${file}: input artifact binding/hash mismatch`);
  const fileRows = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    let row;
    try { row = JSON.parse(line); } catch (error) { throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`); }
    if (!validateEvent(row)) throw new Error(`${file}:${index + 1}: ${ajv.errorsText(validateEvent.errors)}`);
    return row;
  });
  if (!fileRows.length || fileRows.some((row) => row.device.deviceId !== expected.deviceId)) throw new Error(`${file}: device/manifest binding mismatch`);
  rows.push(...fileRows);
  inputArtifacts.push({ kind: 'events', path: file, sha256 });
}

assertHomogeneous(rows, metadata);
const scored = rows.filter((row) => !row.excluded);
const missingInputs = validityFailures(rows, scored);
let result;
if (missingInputs.length) {
  result = { schemaVersion: '1.2.0', runId: metadata.runId, status: 'blocked', startedAt: metadata.startedAt, owner: metadata.owner, blockedReasons: missingInputs, missingInputs, sampleCounts: counts(rows, scored), artifacts: inputArtifacts };
} else {
  result = score(rows, scored, metadata, inputArtifacts);
}
if (!validateMetrics(result)) throw new Error(`scored output violates raw metrics schema: ${ajv.errorsText(validateMetrics.errors)}`);
await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);

function score(attempted, scoredRows, meta, artifacts) {
  for (const row of scoredRows) if (row.resources.rssPeakMiB < row.resources.rssBaselineMiB) throw new Error(`${row.eventId}: rssPeakMiB below baseline`);
  const seed = meta.scorer.bootstrapSeed;
  const rng = mulberry32(seed);
  const strata = Map.groupBy(scoredRows, cellKey);
  const samples = Array.from({ length: meta.scorer.bootstrapIterations }, () => Array.from(strata.values()).flatMap((group) => Array.from({ length: group.length }, () => group[Math.floor(rng() * group.length)])));
  const bootstrap = (fn, unit) => shape(fn(scoredRows), percentile(samples.map(fn).sort((a, b) => a - b), .025), percentile(samples.map(fn).sort((a, b) => a - b), .975), unit, scoredRows.length);
  const wilsonMetric = (success, n, unit = 'ratio') => { const interval = wilson(success, n); return shape(success / n, interval.lower, interval.upper, unit, n); };
  const mean = (getter) => (data) => data.reduce((sum, row) => sum + getter(row), 0) / data.length;
  const quantile = (getter, q) => (data) => percentile(data.map(getter).sort((a, b) => a - b), q);
  const mixed = attempted.filter((row) => row.language === 'mixed').flatMap((row) => row.keyTermsExpected.map((term) => Number(row.keyTermsObserved.includes(term))));
  const usableValues = scoredRows.map(usable);
  const slotValues = scoredRows.map((row) => Number(exactObject(row.slotsExpected, row.slotsObserved)));
  const successfulValues = attempted.map((row) => Number(!row.excluded && row.errors.length === 0 && row.partialRevisions.some((revision) => revision.final)));
  const draftValues = attempted.map((row) => Number(row.draftPreserved));
  const crashValues = attempted.map((row) => Number(row.errors.some((error) => error.code === 'CRASH')));
  const result = {
    schemaVersion: '1.2.0', runId: meta.runId, status: 'complete', startedAt: meta.startedAt, owner: meta.owner,
    scorer: meta.scorer, corpus: meta.corpus, candidate: scoredRows[0].candidate,
    devices: [...new Map(scoredRows.map((row) => [row.device.deviceId, row.device])).values()], app: scoredRows[0].app,
    networkProfiles: [...new Map(scoredRows.map((row) => [row.network.profile, row.network])).values()], sampleCounts: counts(attempted, scoredRows),
    latencyMs: { firstPartial: { p50: bootstrap(quantile((r) => r.timestamps.firstPartialMs - r.timestamps.audioStartMs, .5), 'ms'), p95: bootstrap(quantile((r) => r.timestamps.firstPartialMs - r.timestamps.audioStartMs, .95), 'ms') }, finalAfterStop: { p50: bootstrap(quantile((r) => r.timestamps.finalMs - r.timestamps.audioStopMs, .5), 'ms'), p95: bootstrap(quantile((r) => r.timestamps.finalMs - r.timestamps.audioStopMs, .95), 'ms') } },
    accuracy: { wer: bootstrap(mean((r) => editRate(r.reference, r.hypothesis, words)), 'ratio'), cer: bootstrap(mean((r) => editRate(r.reference, r.hypothesis, chars)), 'ratio'), usableCommandRate: wilsonMetric(sum(usableValues), usableValues.length), slotExactRate: wilsonMetric(sum(slotValues), slotValues.length), mixedKeyTermExactRate: wilsonMetric(sum(mixed), mixed.length) },
    stability: { flickerRewritesPer10s: bootstrap(mean(flicker), 'rewrites/10s'), monotonicRevisionViolationRate: bootstrap(mean(revisionViolation), 'ratio') },
    resources: { cpuAveragePercent: bootstrap(mean((r) => r.resources.cpuAveragePercent), 'percent'), rssDeltaPeakMiB: bootstrap(quantile((r) => r.resources.rssPeakMiB - r.resources.rssBaselineMiB, .5), 'MiB'), batteryDeltaPercentPer30Min: bootstrap(mean((r) => (r.resources.batteryStartPercent - r.resources.batteryEndPercent) * 30 / r.resources.measurementMinutes), 'percentage-points/30min') },
    network: { bytesSent: bootstrap(mean((r) => r.resources.networkBytesSent), 'bytes/utterance'), bytesReceived: bootstrap(mean((r) => r.resources.networkBytesReceived), 'bytes/utterance') },
    cost: { total: bootstrap((data) => sum(data.map((r) => r.resources.cost)), scoredRows[0].resources.currency) },
    reliability: { successfulFinalRate: wilsonMetric(sum(successfulValues), attempted.length), draftPreservationRate: wilsonMetric(sum(draftValues), attempted.length), crashRate: bootstrap(mean((r) => Number(r.errors.some((e) => e.code === 'CRASH'))), 'ratio') },
    acceptance: {}, privacy: meta.privacyCost, artifacts
  };
  const gates = [['firstPartialP50', result.latencyMs.firstPartial.p50, 350, 'upper'], ['firstPartialP95', result.latencyMs.firstPartial.p95, 600, 'upper'], ['finalAfterStopP50', result.latencyMs.finalAfterStop.p50, 800, 'upper'], ['finalAfterStopP95', result.latencyMs.finalAfterStop.p95, 1200, 'upper'], ['usableCommandRate', result.accuracy.usableCommandRate, .95, 'lower'], ['mixedKeyTermExactRate', result.accuracy.mixedKeyTermExactRate, .95, 'lower'], ['flickerRewritesPer10s', result.stability.flickerRewritesPer10s, 2, 'upper'], ['cpuAveragePercent', result.resources.cpuAveragePercent, 20, 'upper'], ['rssDeltaPeakMiB', result.resources.rssDeltaPeakMiB, 100, 'upper'], ['batteryDeltaPercentPer30Min', result.resources.batteryDeltaPercentPer30Min, 3, 'upper'], ['successfulFinalRate', result.reliability.successfulFinalRate, .99, 'lower'], ['draftPreservationRate', result.reliability.draftPreservationRate, 1, 'lower']];
  for (const [name, metric, threshold, bound] of gates) result.acceptance[name] = { threshold, bound, conservativePass: bound === 'upper' ? metric.upper95 <= threshold : metric.lower95 >= threshold };
  return result;
}

function validityFailures(attempted, scored) {
  const failures = [];
  if (attempted.length < 500 || scored.length < 500) failures.push('at least 500 attempted and 500 scored utterances required');
  const countsByCell = Map.groupBy(scored, cellKey);
  for (const e of ['quiet','street','headset','far-field']) for (const l of ['zh-CN','en-US','mixed']) for (const len of ['short','long']) for (const i of ['ordinary','sensitive']) if ((countsByCell.get(`${e}.${l}.${len}.${i}`)?.length || 0) < 20) failures.push(`matrix cell ${e}.${l}.${len}.${i} requires >=20 scored`);
  for (const os of ['iOS','Android']) if (!attempted.some((r) => r.device.os === os)) failures.push(`representative ${os} device required`);
  if (!attempted.some((r) => r.network.profile === 'offline') || !attempted.some((r) => r.network.profile !== 'offline')) failures.push('offline and connected network profiles required');
  for (const mode of ['foreground','background']) if (!attempted.some((r) => r.captureMode === mode)) failures.push(`${mode} capture mode required`);
  if (!attempted.some((r) => r.language === 'mixed' && r.keyTermsExpected.length)) failures.push('annotated mixed-language key terms required');
  return failures;
}
function assertHomogeneous(rows, meta) {
  if (!rows.length) throw new Error('no event rows');
  const key = (r) => JSON.stringify([r.candidate.provider,r.candidate.model,r.candidate.modelVersion,r.candidate.region,r.app.name,r.app.version,r.app.build]);
  if (rows.some((r) => key(r) !== key(rows[0]))) throw new Error('mixed candidate/provider/model/region/app version in one run');
  if (!meta.scorer?.version || !meta.scorer?.commit) throw new Error('scorer version and commit required');
}
function flicker(row) { let changed = 0; for (let i=1;i<row.partialRevisions.length;i++) { const prev=row.partialRevisions[i-1], cur=row.partialRevisions[i]; for(let t=0;t<prev.activeTrailingStart;t++) if(prev.tokens[t]!==cur.tokens[t]) changed++; } return changed*10/((row.timestamps.audioStopMs-row.timestamps.audioStartMs)/1000); }
function revisionViolation(row) { return Number(row.partialRevisions.some((r,i,a)=>i&&r.revisionId<=a[i-1].revisionId)); }
function usable(r) { return Number(r.referenceIntent===r.hypothesisIntent&&exactObject(r.slotsExpected,r.slotsObserved)); }
function exactObject(a,b){return JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());}
function editRate(a,b,tokenize){const x=tokenize(a.normalize('NFC').toLowerCase()),y=tokenize(b.normalize('NFC').toLowerCase());return levenshtein(x,y)/Math.max(1,x.length);}
function words(s){return s.split(/\s+/).filter(Boolean);} function chars(s){return [...s.replace(/\s+/g,'')];}
function levenshtein(a,b){let p=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const c=[i];for(let j=1;j<=b.length;j++)c[j]=Math.min(c[j-1]+1,p[j]+1,p[j-1]+Number(a[i-1]!==b[j-1]));p=c;}return p[b.length];}
function wilson(success,n){const z=1.959963984540054,p=success/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return{lower:c-m,upper:c+m};}
function shape(point,lower95,upper95,unit,n){return{point,lower95,upper95,unit,n};} function sum(v){return v.reduce((a,b)=>a+b,0);} function percentile(a,q){return a[Math.max(0,Math.ceil(q*a.length)-1)];}
function cellKey(r){return r.caseId.split('.').slice(0,4).join('.');}
function counts(a,s){return{attempted:a.length,scored:s.length,excluded:a.length-s.length};}
function mulberry32(v){return()=>{v|=0;v=v+0x6D2B79F5|0;let t=Math.imul(v^v>>>15,1|v);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function parseArgs(values){const out={events:[]};for(let i=0;i<values.length;i+=2){const key=values[i]?.replace(/^--/,'');if(!key||values[i+1]===undefined)throw new Error('arguments must be --key value pairs');if(key==='events')out.events.push(values[i+1]);else out[key]=values[i+1];}return out;}
