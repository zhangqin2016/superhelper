#!/usr/bin/env node
// Records are displayed at the current artifact schema whether or not the
// background pass has reached them. The stored artifacts are a cache, not the
// source of truth for display — so no schema bump can make the app look wrong,
// or make it work at startup to look right. Measured on a real database for one
// 50-record page: 13 ms to re-derive in memory, 205 ms to write back, which is
// why only persistence is deferred. [gate: resumable-enrichment]
// Run: node scripts/test-artifact-freshness.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { withFreshArtifacts } = require("../src/main/artifact-freshness.js");
const { ARTIFACT_SCHEMA_VERSION, RESULT_BLOCK_SCHEMA_VERSION } = require("../src/main/session-artifact-backfill.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-freshness-"));

function stale(id, extra = {}) {
  return {
    id,
    role: "assistant",
    content: "answer",
    record: {
      kind: "turn",
      turnId: `turn-${id}`,
      assistantText: "answer",
      tools: [],
      fileChanges: [],
      artifactSchemaVersion: 1,
      resultBlockSchemaVersion: 1,
      artifacts: [{ from: "an older schema" }],
      ...extra,
    },
  };
}

try {
  check("a record stored at an older schema is displayed at the current one", () => {
    const { conversation, upgraded } = withFreshArtifacts([stale("m1")], workspace);
    assert.equal(upgraded, 1);
    assert.equal(conversation[0].record.artifactSchemaVersion, ARTIFACT_SCHEMA_VERSION);
    assert.equal(conversation[0].record.resultBlockSchemaVersion, RESULT_BLOCK_SCHEMA_VERSION);
    assert.ok(Array.isArray(conversation[0].record.resultBlocks));
  });

  check("reading never mutates what the store handed out", () => {
    const original = stale("m2");
    const before = JSON.stringify(original);
    const { conversation } = withFreshArtifacts([original], workspace);
    assert.equal(JSON.stringify(original), before, "the stored object is untouched");
    assert.notEqual(conversation[0], original, "the caller gets a copy");
    assert.equal(conversation[0].record.artifactSchemaVersion, ARTIFACT_SCHEMA_VERSION);
  });

  check("a record already at the current schema is passed through by identity", () => {
    const fresh = stale("m3", { artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION, resultBlockSchemaVersion: RESULT_BLOCK_SCHEMA_VERSION, artifacts: [], resultBlocks: [] });
    const { conversation, upgraded } = withFreshArtifacts([fresh], workspace);
    assert.equal(upgraded, 0, "nothing to do");
    assert.equal(conversation[0], fresh, "and no copy is made");
  });

  check("the whole page is covered, and messages without a record are left alone", () => {
    const page = [stale("a"), { id: "u", role: "user", content: "question" }, stale("b"), null];
    const { conversation, upgraded } = withFreshArtifacts(page, workspace);
    assert.equal(upgraded, 2);
    assert.equal(conversation.length, 4);
    assert.equal(conversation[1].content, "question");
    assert.equal(conversation[3], null);
  });

  check("every failure path answers with the stored record, which is the old behaviour", () => {
    assert.deepEqual(withFreshArtifacts([], workspace), { conversation: [], upgraded: 0 });
    assert.deepEqual(withFreshArtifacts(null, workspace), { conversation: [], upgraded: 0 });
    const record = stale("m4");
    // No workspace: artifact relevance is judged against a root, so without one
    // there is nothing to judge and the stored answer stands.
    const noRoot = withFreshArtifacts([record], "");
    assert.equal(noRoot.upgraded, 0);
    assert.equal(noRoot.conversation[0], record);
    // A record that cannot be derived at all still displays as stored.
    const poison = { id: "p", role: "assistant", record: { get tools() { throw new Error("corrupt"); } } };
    const survived = withFreshArtifacts([poison], workspace);
    assert.equal(survived.conversation[0], poison);
    assert.equal(survived.upgraded, 0);
  });

  check("display no longer depends on the background pass having run", () => {
    const src = fs.readFileSync(new URL("../src/main/session-manager.js", import.meta.url), "utf8");
    assert.match(src, /withFreshArtifacts\(page\.conversation/, "the conversation read path derives");
    assert.match(src, /conversation: fresh\.conversation/, "and returns what it derived");
    // The background pass may still run — it keeps the cache warm — but nothing
    // may depend on it, which is what stopped a schema bump from wedging launch.
    assert.match(src, /_startBackgroundEnrichment\(\)/, "the cache warm-up is still scheduled");
  });

  console.log(`\n${checks} checks passed (artifact freshness)`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
