"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { LongTaskStore } = require("./store");

function safeId(value) {
  return String(value || "legacy").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100);
}

function legacyTerminal(record) {
  if (record.status === "stopped") return "cancelled";
  if (record.status === "failed") return "failed";
  if (record.status === "exited") return Number(record.exitCode) === 0 ? "succeeded" : "failed";
  return "outcome_unknown";
}

function migrateLegacyProcessJobs({ legacyPath, dbPath } = {}) {
  const source = path.resolve(String(legacyPath || ""));
  const marker = `${source}.sqlite-migrated`;
  if (fs.existsSync(marker)) return { ok: true, alreadyMigrated: true, imported: 0 };
  if (!fs.existsSync(source)) return { ok: true, missing: true, imported: 0 };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(source, "utf8")); }
  catch { return { ok: false, error: "LEGACY_REGISTRY_CORRUPT", imported: 0 }; }
  if (!parsed || typeof parsed.jobs !== "object" || Array.isArray(parsed.jobs)) {
    return { ok: false, error: "LEGACY_REGISTRY_CORRUPT", imported: 0 };
  }
  const store = new LongTaskStore({ filePath: dbPath });
  let imported = 0;
  try {
    for (const [key, record] of Object.entries(parsed.jobs)) {
      if (!record || typeof record !== "object") continue;
      const sourceId = safeId(record.jobId || key);
      const id = `legacy_${sourceId}`;
      const scope = {
        ownerScope: "legacy-local",
        sessionId: "legacy-unscoped",
        projectId: "legacy-unscoped",
        turnId: `legacy-${sourceId}`,
      };
      const created = store.createJob({
        id, scope,
        command: String(record.command || "legacy-process"),
        args: Array.isArray(record.args) ? record.args : [],
        cwd: fs.existsSync(record.cwd || "") ? record.cwd : path.dirname(source),
        replayPolicy: "never",
        idempotencyKey: `legacy:${sourceId}`,
        outputFiles: record.outputFiles,
      });
      if (created.status !== "starting") continue;
      const lease = store.claimLease(scope, id, { holder: "legacy-migration", ttlMs: 30_000 });
      if (!lease.ok) continue;
      const terminal = store.markTerminal(scope, id, {
        holder: "legacy-migration",
        fencingEpoch: lease.job.fencingEpoch,
        status: legacyTerminal(record),
        exitCode: record.exitCode,
        signal: record.signal,
        error: record.error || (record.status === "running" ? "LEGACY_ACTIVE_OUTCOME_UNKNOWN" : null),
        outputFiles: record.outputFiles,
      });
      if (terminal.ok) imported += 1;
    }
  } finally { store.close(); }
  fs.writeFileSync(marker, `${JSON.stringify({ version: 1, imported, migratedAt: Date.now() })}\n`, { mode: 0o600 });
  return { ok: true, imported };
}

module.exports = { migrateLegacyProcessJobs };
