#!/usr/bin/env node
// Regression for the context-loss root cause: hasResumeArtifacts must treat the
// shared OpenCode SQLite (opencode-shared/opencode.db) as the resume artifact.
// It previously grepped Claude-era jsonl dirs that never contain an OpenCode
// `ses_…` id, so it reported "stale" and the caller wiped good engine state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-resume-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = tmp;
process.env.LILY_DOCUMENTS_DIR = tmp;

const { opencodeDbPath, opencodeSessionDir } = await import("../src/main/config.js");
const { hasResumeArtifacts } = await import("../src/main/session-engine-recovery.js");

const SID = "11111111-2222-3333-4444-555555555555";
const RESUME_ID = "ses_1170fda56ffebvM26kN00x4pBn"; // an OpenCode id, never in any jsonl

// No db yet, no legacy artifacts -> genuinely nothing to resume.
assert.equal(hasResumeArtifacts(SID, RESUME_ID), false, "no db => not resumable");
assert.equal(hasResumeArtifacts(SID, null), false, "no resume id => not resumable");

// The shared OpenCode serve wrote its app-level db. THIS is the resume artifact
// even though the ses_ id appears in no Claude-era guide/config dir.
const sharedDb = opencodeDbPath();
fs.mkdirSync(path.dirname(sharedDb), { recursive: true });
fs.writeFileSync(sharedDb, "SQLite format 3\0...");
assert.equal(hasResumeArtifacts(SID, RESUME_ID), true, "shared db present => resumable");

// An empty shared db file is not a usable artifact.
fs.writeFileSync(sharedDb, "");
assert.equal(hasResumeArtifacts(SID, RESUME_ID), false, "empty shared db => not resumable");

// Legacy per-session DBs remain accepted for users upgrading from older builds.
const dir = opencodeSessionDir(SID);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "opencode.db"), "SQLite format 3\0...");
assert.equal(hasResumeArtifacts(SID, RESUME_ID), true, "legacy per-session db present => resumable");

// An empty legacy db file is not a usable artifact.
fs.writeFileSync(path.join(dir, "opencode.db"), "");
assert.equal(hasResumeArtifacts(SID, RESUME_ID), false, "empty legacy db => not resumable");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("resume-artifacts: ok");
