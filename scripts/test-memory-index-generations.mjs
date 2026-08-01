"use strict";
/**
 * §14.5 P3: immutable semantic index generations. writeIndex is atomic
 * (temp + rename) so a crash never exposes a torn index, and the embedding
 * model tags the generation file — changing models builds a new generation
 * instead of mutating the old one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mvi = require("../src/main/memory-vector-index.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-gen-"));
const oldUserData = process.env.LILY_USER_DATA_DIR;
process.env.LILY_USER_DATA_DIR = tmp;

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("writeIndex is atomic: no temp file remains and the index round-trips", async () => {
    const file = path.join(tmp, "gen", "a.json");
    assert.equal(mvi.writeIndex(file, { schemaVersion: 2, entries: [{ key: "k", vector: [1, 2, 3] }] }), true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.entries.length, 1);
    const leftovers = fs.readdirSync(path.join(tmp, "gen")).filter((f) => f.endsWith(".tmp"));
    assert.equal(leftovers.length, 0, "no torn temp index survives");
  });

  await check("semanticRelevanceMap tags generations by embedding model", async () => {
    const projectKey = "proj-gen";
    const caller = async (texts) => texts.map(() => [1, 0, 0]);
    await mvi.semanticRelevanceMap(
      [{ id: "a", kind: "scene_fact", sourceVersion: "1", text: "The bell rings." }],
      "bell",
      { caller, projectKey, model: "model-A" },
    );
    await mvi.semanticRelevanceMap(
      [{ id: "a", kind: "scene_fact", sourceVersion: "1", text: "The bell rings." }],
      "bell",
      { caller, projectKey, model: "model-B" },
    );
    const indexDir = path.join(tmp, "memory-vector-index");
    const files = fs.readdirSync(indexDir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 2, `two model generations exist (${files.join(", ")})`);
    // Changing model never mutates the old generation: distinct model tags
    // produce distinct immutable files; re-running model-A is byte-stable.
    const before = fs.readFileSync(path.join(indexDir, files[0]), "utf8");
    await mvi.semanticRelevanceMap(
      [{ id: "a", kind: "scene_fact", sourceVersion: "1", text: "The bell rings." }],
      "bell",
      { caller: async (t) => t.map(() => [1, 0, 0]), projectKey: "proj-gen", model: "model-A" },
    );
    const afterFiles = fs.readdirSync(indexDir).filter((f) => f.endsWith(".json"));
    assert.equal(afterFiles.length, files.length, "re-running a model does not mint a new generation");
    assert.equal(fs.readFileSync(path.join(indexDir, files[0]), "utf8"), before, "old generation byte-stable");
  });

  console.log(`PASS: test-memory-index-generations (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
} finally {
  if (oldUserData === undefined) delete process.env.LILY_USER_DATA_DIR;
  else process.env.LILY_USER_DATA_DIR = oldUserData;
  fs.rmSync(tmp, { recursive: true, force: true });
}
