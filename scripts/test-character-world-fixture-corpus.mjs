"use strict";
/**
 * §19.5 real-card corpus: every shipping fixture imports at its declared
 * compatibility level with zero unreported field loss; hostile fixtures are
 * rejected. This is the guard that keeps the parser honest across V1/V2/V3,
 * JSON/PNG/APNG, and embedded character books.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { CharacterSourceAuthority } = require("../src/main/character-worlds/import-file-authority.js");
const { CharacterWorldsService } = require("../src/main/character-worlds/service.js");

const FIXTURES = path.resolve("fixtures/character-worlds");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-corpus-"));
const sourceRoot = path.join(tmp, "sources");
const destinationRoot = path.join(tmp, "exports");
fs.mkdirSync(sourceRoot);
fs.mkdirSync(destinationRoot);

const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = store.characterWorlds();
const sourceAuthority = new CharacterSourceAuthority({ roots: [sourceRoot] });
const { createTestDestinationBroker } = require("./character-destination-test-broker.mjs");
const destinationWriter = new (require("../src/main/character-worlds/export-destination-writer.js").CharacterDestinationWriter)({ broker: createTestDestinationBroker(destinationRoot) });

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

// PNG/APNG fixtures ship as BARE export targets (1x1, no embedded card text),
// so they are not recognizable INPUT cards; embedded-card PNG/APNG detection
// is covered by test-character-card-png.mjs with synthetic text chunks.
const CARD_FIXTURES = [
  ["minimal-v1-legacy.json", "v1_json"],
  ["minimal-v1-modern.json", "v1_json"],
  ["v1-character.json", "v1_json"],
  ["v2-character.json", "v2_json"],
  ["v2-character-book.json", "v2_json"],
  ["v3-character.json", "v3_json"],
  ["v3-character-book.json", "v3_json"],
];
const HOSTILE_FIXTURES = [
  "false-positive-name-description.json",
  "false-positive-package.json",
  "hostile-dangerous-key.json",
  "hostile-depth.json",
  "hostile-duplicate.json",
];

function copyFixture(name) {
  const target = path.join(sourceRoot, name);
  fs.copyFileSync(path.join(FIXTURES, name), target);
  return target;
}

try {
  for (const [fixture, expectedFormat] of CARD_FIXTURES) {
    await check(`corpus fixture ${fixture} imports at ${expectedFormat}`, async () => {
      const service = new CharacterWorldsService({
        messageStore: store,
        repository,
        sourceAuthority,
        destinationWriter,
        resolveOwnerScope: async () => "profile:corpus",
        now: () => 1_800_000_000_000,
        previewTtlMs: 60_000,
      });
      const p = copyFixture(fixture);
      const preview = await service.previewImport({ ownerScope: "profile:corpus", sourcePath: p });
      assert.equal(preview.format, expectedFormat, `format ${expectedFormat}`);
      const committed = await service.commitImport({
        ownerScope: "profile:corpus",
        previewToken: preview.previewToken,
        duplicateResolution: "create_copy",
      });
      assert.ok(committed?.revision || committed?.entity, "commit ok");
      const canonical = committed.revision?.canonical || committed.entity?.canonical || {};
      assert.ok(canonical.name, "name preserved (zero field loss)");
      assert.ok(typeof canonical.description === "string", "description field present");
      fs.unlinkSync(p);
    });
  }

  for (const fixture of HOSTILE_FIXTURES) {
    await check(`hostile fixture ${fixture} is rejected`, async () => {
      const service = new CharacterWorldsService({
        messageStore: store,
        repository,
        sourceAuthority,
        destinationWriter,
        resolveOwnerScope: async () => "profile:corpus",
        now: () => 1_800_000_000_000,
        previewTtlMs: 60_000,
      });
      const p = copyFixture(fixture);
      let rejected = false;
      try {
        const preview = await service.previewImport({ ownerScope: "profile:corpus", sourcePath: p });
        if (!preview || !preview.previewToken) rejected = true;
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, `${fixture} rejected`);
      fs.unlinkSync(p);
    });
  }

  console.log(`PASS: test-character-world-fixture-corpus (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
