#!/usr/bin/env node
// Regression for the context-loss root cause: hasResumeArtifacts must treat the
// per-session OpenCode SQLite (opencode-sessions/<id>/opencode.db) as the resume
// artifact. It previously grepped Claude-era jsonl dirs that never contain an
// OpenCode `ses_…` id, so it ALWAYS reported "stale" and the caller wiped a good
// db on every reopen — every conversation came back with zero engine context.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-resume-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = tmp;
process.env.LILY_DOCUMENTS_DIR = tmp;

const { opencodeSessionDir } = await import("../src/main/config.js");
const { hasResumeArtifacts } = await import("../src/main/session-engine-recovery.js");

const SID = "11111111-2222-3333-4444-555555555555";
const RESUME_ID = "ses_1170fda56ffebvM26kN00x4pBn"; // an OpenCode id, never in any jsonl

// No db yet, no legacy artifacts -> genuinely nothing to resume.
assert.equal(hasResumeArtifacts(SID, RESUME_ID), false, "no db => not resumable");
assert.equal(hasResumeArtifacts(SID, null), false, "no resume id => not resumable");

// The engine wrote its per-session db. THIS is the resume artifact — even though
// the ses_ id appears in no Claude-era guide/config dir.
const dir = opencodeSessionDir(SID);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "opencode.db"), "SQLite format 3\0...");
assert.equal(hasResumeArtifacts(SID, RESUME_ID), true, "db present => resumable (must NOT wipe on reopen)");

// An empty db file is not a usable artifact.
fs.writeFileSync(path.join(dir, "opencode.db"), "");
assert.equal(hasResumeArtifacts(SID, RESUME_ID), false, "empty db => not resumable");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("resume-artifacts: ok");
