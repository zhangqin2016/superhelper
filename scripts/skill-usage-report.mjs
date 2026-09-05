#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { aggregateSkillUsage } = require('../src/main/skill-usage-metrics');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
let db;
try {
  const file = args.includes('--db') ? value('--db') : '';
  if (!file || file.startsWith('--') || !fs.statSync(file).isFile()) throw new Error('Provide an existing database with --db <messages.db>');
  const threshold = args.includes('--max-unread-rate') ? Number(value('--max-unread-rate')) : null;
  if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) throw new Error('Rate must be between 0 and 1');
  db = new DatabaseSync(path.resolve(file), { readOnly: true });
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(column => column.name));
  const compressed = columns.has('envelope_blob');
  if (!compressed && !columns.has('record')) throw new Error('Unsupported messages schema');
  let invalidRecords = 0, recordsWithoutAudit = 0;
  function* audits() {
    for (const row of db.prepare(compressed ? 'SELECT envelope_blob FROM messages' : 'SELECT record FROM messages').iterate()) {
      let record;
      try {
        const decoded = JSON.parse(compressed ? gunzipSync(row.envelope_blob, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8') : row.record);
        record = compressed ? decoded?.record : decoded;
      } catch { invalidRecords++; continue; }
      const audit = record?.meta?.skillUsageAudit;
      if (!audit || !Array.isArray(audit.candidates)) { recordsWithoutAudit++; continue; }
      yield audit;
    }
  }
  const metrics = aggregateSkillUsage(audits());
  const report = { ...metrics, invalidRecords, recordsWithoutAudit, meaning: 'Current-turn candidate/read observations, not model selection or task completion. Legacy outcomes are unknown.' };
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.meaning);
    console.table([{ turns: metrics.turns, matched: metrics.matched, read: metrics.read, unread: metrics.unread, unknown: metrics.unknown, rate: metrics.matchedUnreadRate }]);
    console.table(metrics.worst.slice(0, 20));
  }
  if (threshold !== null && metrics.matchedUnreadRate === null) {
    console.error('skill-usage-report: insufficient known read outcomes for the requested threshold');
    process.exitCode = 2;
  } else if (threshold !== null && metrics.matchedUnreadRate > threshold) process.exitCode = 1;
} catch (error) { console.error(`skill-usage-report: ${error.message}`); process.exitCode = 2; }
finally { db?.close(); }
