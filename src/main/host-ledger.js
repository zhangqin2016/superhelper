"use strict";
// Receipts a platform script records for the host, beside whatever it prints:
// the printed line is the model's to filter out (`grep -v`), the ledger is not.
// One JSONL file per UTC day under userData/<name>, kept for a week.
const fs = require("node:fs");
const path = require("node:path");
const { getLogger } = require("./logger");

const log = getLogger("host-ledger");
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

function ledgerDir(userDataDir, name) {
  return userDataDir ? path.join(userDataDir, name) : "";
}

function defaultLedgerDir(name) {
  try { return ledgerDir(require("electron").app.getPath("userData"), name); } catch { return ""; }
}

function ledgerFileName(ms) {
  return `${new Date(ms).toISOString().slice(0, 10)}.jsonl`;
}

function pruneLedger(dir, now) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const oldest = ledgerFileName(now - KEEP_DAYS * DAY_MS);
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || name >= oldest) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch (err) {
      log.warn("ledger prune failed: %s %s", name, err?.message || err);
    }
  }
}

/** Entries recorded at or after `since` (epoch ms) that `accept` admits, oldest first. */
function readLedger({ dir, since = 0, now = Date.now(), accept = () => true } = {}) {
  if (!dir || !(Number(since) > 0)) return [];
  pruneLedger(dir, now);
  const entries = [];
  for (let day = Math.floor(since / DAY_MS) * DAY_MS; day <= now && entries.length < MAX_ENTRIES; day += DAY_MS) {
    const file = path.join(dir, ledgerFileName(day));
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (err) {
      if (err?.code !== "ENOENT") log.warn("ledger unreadable: %s %s", file, err?.message || err);
      continue;
    }
    let torn = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { torn += 1; continue; }
      if (Number(entry?.at) >= since && accept(entry)) entries.push(entry);
      if (entries.length >= MAX_ENTRIES) break;
    }
    if (torn) log.warn("ledger: %d unparsable line(s) skipped in %s", torn, file);
  }
  return entries;
}

module.exports = { defaultLedgerDir, ledgerDir, ledgerFileName, readLedger };
