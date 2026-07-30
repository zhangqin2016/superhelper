#!/usr/bin/env node
// Character Worlds import preview, commit, and export contract.
// Run: node scripts/test-character-worlds-import.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createTestDestinationBroker } from "./character-destination-test-broker.mjs";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  CharacterWorldsService,
  CharacterSourceAuthority,
  CharacterDestinationWriter,
} = require("../src/main/character-worlds/service.js");
const { parseCharacterCard } = require("../src/main/character-worlds/card-parser.js");

const OWNER = "profile:local";
const OTHER_OWNER = "profile:other";
const FIXTURES = path.resolve("fixtures/character-worlds");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-worlds-import-"));
const sourceRoot = path.join(tmp, "sources");
const destinationRoot = path.join(tmp, "exports");
fs.mkdirSync(sourceRoot);
fs.mkdirSync(destinationRoot);

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

function copyFixture(name, targetName = name) {
  const target = path.join(sourceRoot, targetName);
  fs.copyFileSync(path.join(FIXTURES, name), target);
  return target;
}

function codeIs(code) {
  return (error) => error?.code === code;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stripPngTextChunks(bytes) {
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!["tEXt", "zTXt", "iTXt"].includes(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

const store = new MessageStore(
  path.join(tmp, "messages.db"),
  path.join(tmp, "blobs"),
);
const repository = store.characterWorlds();
const sourceAuthority = new CharacterSourceAuthority({ roots: [sourceRoot] });
const destinationBroker = createTestDestinationBroker(destinationRoot);
const destinationWriter = new CharacterDestinationWriter({ broker: destinationBroker });
let currentOwner = OWNER;
let clock = 1_800_000_000_000;

function makeService(overrides = {}) {
  return new CharacterWorldsService({
    messageStore: store,
    repository,
    sourceAuthority,
    destinationWriter,
    resolveOwnerScope: async () => currentOwner,
    now: () => clock,
    previewTtlMs: 60_000,
    ...overrides,
  });
}

const service = makeService();

try {
  console.log("character-worlds-import:");
  const v2Path = copyFixture("v2-character.json");
  let committedV2;

  await check("preview is async and side-effect free", async () => {
    const beforeBlobRows = store.db.get("SELECT COUNT(*) AS count FROM blobs").count;
    const preview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: v2Path,
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, "characterCard");
    assert.equal(preview.format, "v2_json");
    assert.equal(preview.canonical.name, "Luna V2");
    assert.match(preview.previewToken, /^[a-f0-9]{64}$/);
    assert.equal(repository.listCharacters(OWNER).length, 0);
    assert.equal(store.db.get("SELECT COUNT(*) AS count FROM blobs").count, beforeBlobRows);
    assert(!preview.previewToken.includes(path.basename(v2Path)));
    assert(!JSON.stringify(preview).includes(sourceRoot));

    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: "00".repeat(32) }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
    committedV2 = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.equal(committedV2.entity.currentRevisionId, committedV2.revision.id);
    assert.equal(committedV2.revision.canonical.name, "Luna V2");
    assert.deepEqual(committedV2.compatibility, preview.compatibility);
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
  });

  await check("commit preserves exact source bytes in the repository lifecycle", async () => {
    const source = committedV2.revision.source;
    assert.equal(source.kind, "imported");
    assert.equal(source.format, "v2_json");
    assert.equal(source.container, "json");
    assert.match(source.original.hash, /^[a-f0-9]{64}$/);
    assert.equal(source.original.bytes, fs.statSync(v2Path).size);
    assert.equal(source.originalCanonicalHash, committedV2.revision.contentHash);
    assert.deepEqual(source.compatibility, committedV2.compatibility);
    assert.deepEqual(source.provenance, {
      schemaVersion: 1,
      importer: "lily_character_card_worker",
      sourceFormat: "v2_json",
      sourceContainer: "json",
      canonicalSchemaVersion: 1,
    });
    const originalRef = committedV2.revision.cardAssets.find(
      (asset) => asset.purpose === "character-card-original",
    );
    assert.equal(originalRef.hash, source.original.hash);
    assert.equal(
      sha256(store.blobs.read(originalRef.hash)),
      sha256(fs.readFileSync(v2Path)),
    );
  });

  await check("exact duplicate preview is owner-scoped and commit reuses the existing entity", async () => {
    const before = repository.listCharacters(OWNER).length;
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    assert.equal(preview.duplicates.exact.entityId, committedV2.entity.id);
    assert.equal(preview.duplicates.exact.revisionId, committedV2.revision.id);
    assert.equal(preview.duplicates.canonical.entityId, committedV2.entity.id);
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.equal(committed.entity.id, committedV2.entity.id);
    assert.equal(committed.revision.id, committedV2.revision.id);
    assert.deepEqual(committed.duplicate, {
      kind: "exact",
      reused: true,
      resolution: "reuse_existing",
    });
    assert.equal(committed.matchedSourceRevisionId, committedV2.revision.id);
    assert.equal(repository.listCharacters(OWNER).length, before);
  });

  await check("exact reimport returns the edited current revision and identifies its source match", async () => {
    const editedSourcePath = path.join(sourceRoot, "edited-current-source.json");
    const sourceCard = JSON.parse(fs.readFileSync(v2Path, "utf8"));
    sourceCard.data.name = "Edited Current Duplicate";
    fs.writeFileSync(editedSourcePath, JSON.stringify(sourceCard));
    const preview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: editedSourcePath,
    });
    const imported = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    const edited = repository.createRevision({
      ownerScope: OWNER,
      entityId: imported.entity.id,
      baseRevisionId: imported.revision.id,
      canonical: {
        ...imported.revision.canonical,
        description: "Edited after import",
      },
      source: imported.revision.source,
    });

    const duplicatePreview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: editedSourcePath,
    });
    const duplicate = await service.commitImport({
      ownerScope: OWNER,
      previewToken: duplicatePreview.previewToken,
    });
    assert.equal(duplicate.entity.currentRevisionId, edited.id);
    assert.equal(duplicate.revision.id, edited.id);
    assert.equal(duplicate.matchedSourceRevisionId, imported.revision.id);
    assert.deepEqual(duplicate.duplicate, {
      kind: "exact",
      reused: true,
      resolution: "reuse_existing",
    });
  });

  await check("exact reimport repairs a missing original blob catalog and revision link", async () => {
    const recoveryPath = path.join(sourceRoot, "recover-source.json");
    const sourceCard = JSON.parse(fs.readFileSync(v2Path, "utf8"));
    sourceCard.data.name = "Recover Original Asset";
    fs.writeFileSync(recoveryPath, JSON.stringify(sourceCard));
    const preview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: recoveryPath,
    });
    const imported = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    const original = imported.revision.cardAssets.find(
      (asset) => asset.purpose === "character-card-original",
    );
    assert(original);

    store.db.exec("DROP TRIGGER character_revision_blobs_no_delete");
    store.db.run(
      "DELETE FROM character_revision_blobs WHERE revision_id = ? AND hash = ?",
      imported.revision.id,
      original.hash,
    );
    store.db.run("DELETE FROM blobs WHERE hash = ?", original.hash);
    store.db.exec(`
      CREATE TRIGGER character_revision_blobs_no_delete
      BEFORE DELETE ON character_revision_blobs BEGIN
        SELECT RAISE(ABORT, 'character_revision_blobs rows are immutable');
      END
    `);
    store.blobs.remove(original.hash);
    assert.equal(store.blobs.exists(original.hash), false);

    const duplicatePreview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: recoveryPath,
    });
    const repaired = await service.commitImport({
      ownerScope: OWNER,
      previewToken: duplicatePreview.previewToken,
    });
    assert.equal(repaired.entity.id, imported.entity.id);
    assert.equal(repaired.revision.id, imported.revision.id);
    assert.equal(repaired.matchedSourceRevisionId, imported.revision.id);
    assert.equal(store.blobs.exists(original.hash), true);
    assert.equal(
      store.db.get("SELECT refcount FROM blobs WHERE hash = ?", original.hash).refcount,
      1,
    );
    assert.deepEqual(
      { ...store.db.get(
        `SELECT revision_id, owner_scope, hash, bytes, mime, purpose
         FROM character_revision_blobs WHERE revision_id = ? AND hash = ?`,
        imported.revision.id,
        original.hash,
      ) },
      {
        revision_id: imported.revision.id,
        owner_scope: OWNER,
        hash: original.hash,
        bytes: original.bytes,
        mime: original.mime,
        purpose: original.purpose,
      },
    );

    const outputPath = path.join(destinationRoot, "recovered-original.json");
    const capability = await destinationWriter.approve(outputPath);
    const exported = await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: repaired.matchedSourceRevisionId,
      destinationCapability: capability,
    });
    assert.equal(exported.mode, "original");
    assert.deepEqual(fs.readFileSync(outputPath), fs.readFileSync(recoveryPath));
  });

  await check("exact reimport atomically repairs a corrupt existing original blob", async () => {
    const original = committedV2.revision.cardAssets.find(
      (asset) => asset.purpose === "character-card-original",
    );
    const originalBytes = fs.readFileSync(v2Path);
    const blobPath = store.blobs.pathFor(original.hash);
    const catalogBefore = {
      ...store.db.get(
        "SELECT bytes, mime, refcount FROM blobs WHERE hash = ?",
        original.hash,
      ),
    };
    fs.writeFileSync(blobPath, Buffer.alloc(originalBytes.length, 0xa5));
    assert.notEqual(sha256(fs.readFileSync(blobPath)), original.hash);

    const duplicatePreview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: v2Path,
    });
    const repaired = await service.commitImport({
      ownerScope: OWNER,
      previewToken: duplicatePreview.previewToken,
    });
    assert.equal(repaired.entity.id, committedV2.entity.id);
    assert.deepEqual(fs.readFileSync(blobPath), originalBytes);
    assert.deepEqual(
      {
        ...store.db.get(
          "SELECT bytes, mime, refcount FROM blobs WHERE hash = ?",
          original.hash,
        ),
      },
      catalogBefore,
    );

    const outputPath = path.join(destinationRoot, "repaired-corrupt-original.json");
    const capability = await destinationWriter.approve(outputPath);
    const exported = await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: committedV2.revision.id,
      destinationCapability: capability,
    });
    assert.equal(exported.mode, "original");
    assert.deepEqual(fs.readFileSync(outputPath), originalBytes);
  });

  await check("canonical duplicates require explicit create_copy resolution", async () => {
    const variantPath = path.join(sourceRoot, "v2-canonical-variant.json");
    fs.writeFileSync(
      variantPath,
      Buffer.concat([fs.readFileSync(v2Path), Buffer.from("\n ")]),
    );
    const preview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: variantPath,
    });
    assert.equal(preview.duplicates.exact, null);
    assert.equal(preview.duplicates.canonical.entityId, committedV2.entity.id);
    const before = repository.listCharacters(OWNER).length;
    await assert.rejects(
      service.commitImport({
        ownerScope: OWNER,
        previewToken: preview.previewToken,
      }),
      codeIs("IMPORT_DUPLICATE_RESOLUTION_REQUIRED"),
    );
    assert.equal(repository.listCharacters(OWNER).length, before);
    const created = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
      duplicateResolution: "create_copy",
    });
    assert.notEqual(created.entity.id, committedV2.entity.id);
    assert.deepEqual(created.duplicate, {
      kind: "canonical",
      reused: false,
      resolution: "create_copy",
    });
    assert.equal(repository.listCharacters(OWNER).length, before + 1);
  });

  await check("distinct preview tokens for one new source transactionally create one entity", async () => {
    const concurrentPath = path.join(sourceRoot, "concurrent-import.json");
    const card = JSON.parse(fs.readFileSync(v2Path, "utf8"));
    card.data.name = "Concurrent Import Unique";
    fs.writeFileSync(concurrentPath, JSON.stringify(card));
    const [firstPreview, secondPreview] = await Promise.all([
      service.previewImport({ ownerScope: OWNER, sourcePath: concurrentPath }),
      service.previewImport({ ownerScope: OWNER, sourcePath: concurrentPath }),
    ]);
    assert.equal(firstPreview.duplicates.exact, null);
    assert.equal(secondPreview.duplicates.exact, null);
    const before = repository.listCharacters(OWNER).length;
    const [firstCommit, secondCommit] = await Promise.all([
      service.commitImport({
        ownerScope: OWNER,
        previewToken: firstPreview.previewToken,
      }),
      service.commitImport({
        ownerScope: OWNER,
        previewToken: secondPreview.previewToken,
      }),
    ]);
    assert.equal(firstCommit.entity.id, secondCommit.entity.id);
    assert.equal(repository.listCharacters(OWNER).length, before + 1);
    assert.deepEqual(
      new Set([firstCommit.duplicate.kind, secondCommit.duplicate.kind]),
      new Set(["none", "exact"]),
    );
  });

  await check("duplicate lookup never crosses owner scope", async () => {
    currentOwner = OTHER_OWNER;
    const preview = await service.previewImport({
      ownerScope: OTHER_OWNER,
      sourcePath: v2Path,
    });
    assert.equal(preview.duplicates.exact, null);
    assert.equal(preview.duplicates.canonical, null);
    const committed = await service.commitImport({
      ownerScope: OTHER_OWNER,
      previewToken: preview.previewToken,
    });
    assert.notEqual(committed.entity.id, committedV2.entity.id);
    assert.equal(repository.listCharacters(OTHER_OWNER).length, 1);
    currentOwner = OWNER;
  });

  await check("preview response mutation cannot alter the cached commit payload", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    preview.canonical.name = "Caller mutation";
    preview.compatibility.warnings.push({ code: "CALLER_MUTATION" });
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.equal(committed.revision.canonical.name, "Luna V2");
    assert(!committed.compatibility.warnings.some(
      (warning) => warning.code === "CALLER_MUTATION",
    ));
  });

  await check("a transactional persistence failure leaves the claimed token retryable", async () => {
    let attempts = 0;
    const retryRepository = Object.create(repository);
    retryRepository.importCharacter = (input) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("transient"), { code: "TRANSIENT" });
      return repository.importCharacter(input);
    };
    const retryService = makeService({ repository: retryRepository });
    const preview = await retryService.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    await assert.rejects(
      retryService.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("TRANSIENT"),
    );
    const committed = await retryService.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.equal(committed.revision.canonical.name, "Luna V2");
    assert.equal(attempts, 2);
    await retryService.close();
  });

  await check("unchanged V2 export is byte-for-byte and re-importable", async () => {
    const outputPath = path.join(destinationRoot, "v2-roundtrip.json");
    const destinationCapability = await destinationWriter.approve(outputPath);
    const exported = await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: committedV2.revision.id,
      destinationCapability,
    });
    assert.equal(exported.mode, "original");
    assert.equal(exported.publication, "bound_directory_direct_reservation");
    assert.equal(exported.atomicVisibility, false);
    assert.equal(exported.crashRecovery, "create_only_partial_file_may_remain");
    assert.deepEqual(exported.lossReport, {
      schemaVersion: 1,
      lossy: false,
      preservedOriginal: true,
      sourceFormat: "v2_json",
      outputFormat: "v2_json",
      unknownFields: "preserved_original",
      executableFields: "preserved_original_inert_in_lily",
      omittedExecutable: [],
      ignoredInvalid: [],
      aliasConflicts: [],
      conversions: [],
      unpreserved: [],
      preservedInert: ["/data/vendor_data/color"],
      entries: [],
    });
    assert.deepEqual(fs.readFileSync(outputPath), fs.readFileSync(v2Path));

    const reimportPath = copyFixture("v2-character.json", "v2-exported.json");
    fs.copyFileSync(outputPath, reimportPath);
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: reimportPath });
    assert.equal(preview.ok, true);
    assert.equal(preview.format, "v2_json");
    assert.equal(preview.canonical.name, "Luna V2");
  });

  await check("unchanged V2/V3 JSON, PNG, and APNG exports preserve exact containers", async () => {
    for (const name of [
      "v2-character.png",
      "v3-character.json",
      "v3-character.png",
      "v3-character.apng",
    ]) {
      const sourcePath = copyFixture(name);
      const preview = await service.previewImport({ ownerScope: OWNER, sourcePath });
      const committed = await service.commitImport({
        ownerScope: OWNER,
        previewToken: preview.previewToken,
        duplicateResolution: preview.duplicates.canonical && !preview.duplicates.exact
          ? "create_copy"
          : undefined,
      });
      const outputPath = path.join(destinationRoot, `exact-${name}`);
      const destinationCapability = await destinationWriter.approve(outputPath);
      const exported = await service.exportCharacter({
        ownerScope: OWNER,
        revisionId: committed.revision.id,
        destinationCapability,
      });
      assert.equal(exported.mode, "original");
      assert.deepEqual(fs.readFileSync(outputPath), fs.readFileSync(sourcePath));

      const reimportPath = path.join(sourceRoot, `reimport-${name}`);
      fs.copyFileSync(outputPath, reimportPath);
      const reparsed = await service.previewImport({
        ownerScope: OWNER,
        sourcePath: reimportPath,
      });
      assert.equal(reparsed.ok, true);
      assert.equal(reparsed.canonical.name, preview.canonical.name);
    }
  });

  await check("edited export emits re-importable V3 and removes executable fields", async () => {
    const sourcePath = path.join(sourceRoot, "v3-character.json");
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath });
    const imported = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    const editedCanonical = {
      ...imported.revision.canonical,
      description: "Edited safely in Lily.",
    };
    const editedRevision = repository.createRevision({
      ownerScope: OWNER,
      entityId: imported.entity.id,
      baseRevisionId: imported.revision.id,
      canonical: editedCanonical,
      source: imported.revision.source,
    });
    const outputPath = path.join(destinationRoot, "edited-v3.json");
    const destinationCapability = await destinationWriter.approve(outputPath);
    const exported = await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: editedRevision.id,
      destinationCapability,
    });
    assert.equal(exported.mode, "canonical_v3");
    assert(exported.omittedExecutable.some((pointer) => pointer.includes("stscript")));
    assert.equal(exported.lossReport.lossy, true);
    assert.equal(exported.lossReport.unknownFields, "preserved_inert");
    assert.deepEqual(
      exported.lossReport.omittedExecutable,
      exported.omittedExecutable,
    );
    assert(exported.lossReport.entries.some((entry) => (
      entry.kind === "omitted_executable"
      && entry.path.includes("stscript")
      && entry.lossy === true
    )));
    const bytes = fs.readFileSync(outputPath);
    assert(!bytes.toString("utf8").includes("echo never-run"));
    const reparsed = parseCharacterCard(bytes);
    assert.equal(reparsed.format, "v3_json");
    assert.equal(reparsed.canonical.description, "Edited safely in Lily.");
    assert.equal(reparsed.preserved.data.data.extensions.vendor_theme, "cyan");
  });

  await check("edited V3 export retains safe unknown numeric lexemes exactly", async () => {
    const numericPath = path.join(sourceRoot, "numeric-v3.json");
    fs.writeFileSync(numericPath, Buffer.from(
      '{"spec":"chara_card_v3","spec_version":"3.0","data":{'
      + '"name":"Numeric","description":"Before","future_number":1e400,'
      + '"extensions":{"plugin":"never","safe_number":-0.000e+2}}}',
    ));
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: numericPath });
    const imported = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    const edited = repository.createRevision({
      ownerScope: OWNER,
      entityId: imported.entity.id,
      baseRevisionId: imported.revision.id,
      canonical: { ...imported.revision.canonical, description: "After" },
      source: imported.revision.source,
    });
    const outputPath = path.join(destinationRoot, "numeric-edited.json");
    const destinationCapability = await destinationWriter.approve(outputPath);
    await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: edited.id,
      destinationCapability,
    });
    const output = fs.readFileSync(outputPath, "utf8");
    assert(output.includes('"future_number":1e400'));
    assert(output.includes('"safe_number":-0.000e+2'));
    assert(!output.includes('"plugin"'));
    assert.equal(parseCharacterCard(Buffer.from(output)).canonical.description, "After");
  });

  await check("edited V2 export reports conversion, invalid fields, and alias conflicts", async () => {
    const lossyPath = path.join(sourceRoot, "lossy-v2.json");
    fs.writeFileSync(lossyPath, JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Selected Name",
        char_name: "Conflicting Alias",
        description: { invalid: true },
        vendor_safe: { retained: true },
      },
    }));
    const preview = await service.previewImport({
      ownerScope: OWNER,
      sourcePath: lossyPath,
    });
    assert.deepEqual(preview.compatibility.ignoredInvalid, ["/data/description"]);
    const imported = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.deepEqual(imported.revision.source.compatibility, preview.compatibility);
    const edited = repository.createRevision({
      ownerScope: OWNER,
      entityId: imported.entity.id,
      baseRevisionId: imported.revision.id,
      canonical: {
        ...imported.revision.canonical,
        personality: "Edited",
      },
      source: imported.revision.source,
    });
    const outputPath = path.join(destinationRoot, "lossy-v2-edited.json");
    const capability = await destinationWriter.approve(outputPath);
    const exported = await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: edited.id,
      destinationCapability: capability,
    });

    assert.equal(exported.mode, "canonical_v3");
    assert.equal(exported.lossReport.lossy, true);
    assert.deepEqual(exported.lossReport.ignoredInvalid, ["/data/description"]);
    assert(exported.lossReport.preservedInert.includes("/data/vendor_safe/retained"));
    assert(exported.lossReport.aliasConflicts.some((entry) => (
      entry.canonicalField === "name"
      && entry.selectedPath === "/data/name"
      && entry.omittedPath === "/data/char_name"
    )));
    assert.deepEqual(exported.lossReport.conversions, [{
      kind: "format_version",
      from: "v2_json",
      to: "v3_json",
      lossy: true,
    }]);
    for (const expected of [
      ["ignored_invalid", "/data/description"],
      ["alias_conflict", "/data/char_name"],
      ["format_conversion", null],
    ]) {
      assert(exported.lossReport.entries.some((entry) => (
        entry.kind === expected[0]
        && (expected[1] == null || entry.path === expected[1])
        && entry.lossy === true
      )));
    }
    assert(exported.lossReport.unpreserved.includes("/data/description"));
    assert(exported.lossReport.unpreserved.includes("/data/char_name"));
    const reparsed = parseCharacterCard(fs.readFileSync(outputPath));
    assert.equal(reparsed.format, "v3_json");
    assert.equal(reparsed.canonical.description, "");
    assert.equal(reparsed.preserved.data.data.vendor_safe.retained, true);
  });

  await check("ordinary JSON, PNG, and binary attachments fail open without previews", async () => {
    const ordinaryJson = copyFixture("false-positive-package.json");
    const ordinaryPng = path.join(sourceRoot, "ordinary.png");
    const cardPng = fs.readFileSync(path.join(FIXTURES, "v2-character.png"));
    fs.writeFileSync(ordinaryPng, stripPngTextChunks(cardPng));
    const binaryPath = path.join(sourceRoot, "ordinary.bin");
    fs.writeFileSync(binaryPath, crypto.randomBytes(256));
    const before = repository.listCharacters(OWNER).length;

    for (const sourcePath of [ordinaryJson, ordinaryPng, binaryPath]) {
      const result = await service.previewImport({ ownerScope: OWNER, sourcePath });
      assert.deepEqual(result, {
        ok: false,
        kind: "ordinaryAttachment",
        code: "NOT_A_CHARACTER_CARD",
      });
    }
    assert.equal(repository.listCharacters(OWNER).length, before);
  });

  await check("valid cards remain discoverable after long bounded JSON whitespace", async () => {
    const paddedPath = path.join(sourceRoot, "padded-card.json");
    fs.writeFileSync(
      paddedPath,
      `${" ".repeat(300 * 1024)}${fs.readFileSync(v2Path, "utf8")}`,
    );
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: paddedPath });
    assert.equal(preview.ok, true);
    assert.equal(preview.canonical.name, "Luna V2");
  });

  await check("malformed or hostile card candidates do not downgrade to ordinary files", async () => {
    for (const name of [
      "hostile-dangerous-key.json",
      "hostile-duplicate.json",
    ]) {
      const sourcePath = copyFixture(name);
      await assert.rejects(
        service.previewImport({ ownerScope: OWNER, sourcePath }),
        (error) => typeof error?.code === "string" && error.code !== "NOT_A_CHARACTER_CARD",
      );
    }
  });

  await check("expired previews are terminal and persist nothing", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    const before = repository.listCharacters(OWNER).length;
    clock += 60_001;
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
    assert.equal(repository.listCharacters(OWNER).length, before);
    clock += 1;
  });

  await check("owner is resolved by main process and account switches invalidate previews", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    currentOwner = OTHER_OWNER;
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("IMPORT_OWNER_MISMATCH"),
    );
    currentOwner = OWNER;
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
    await assert.rejects(
      service.previewImport({ ownerScope: OTHER_OWNER, sourcePath: v2Path }),
      codeIs("IMPORT_OWNER_MISMATCH"),
    );
  });

  await check("owner changes during preview or commit are rechecked before exposure or persistence", async () => {
    let releaseRead;
    let readStarted;
    let readCount = 0;
    const delayedAuthority = {
      async read(sourcePath) {
        readCount += 1;
        if (readCount === 1 || readCount === 3) {
          await new Promise((resolve) => {
            releaseRead = resolve;
            readStarted?.();
          });
        }
        return sourceAuthority.read(sourcePath);
      },
    };
    const delayed = makeService({ sourceAuthority: delayedAuthority });

    const previewStarted = new Promise((resolve) => { readStarted = resolve; });
    const previewPromise = delayed.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    await previewStarted;
    currentOwner = OTHER_OWNER;
    releaseRead();
    await assert.rejects(previewPromise, codeIs("IMPORT_OWNER_MISMATCH"));
    currentOwner = OWNER;

    const preview = await delayed.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    const before = repository.listCharacters(OWNER).length;
    const commitStarted = new Promise((resolve) => { readStarted = resolve; });
    const commitPromise = delayed.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    await commitStarted;
    currentOwner = OTHER_OWNER;
    releaseRead();
    await assert.rejects(commitPromise, codeIs("IMPORT_OWNER_MISMATCH"));
    assert.equal(repository.listCharacters(OWNER).length, before);
    currentOwner = OWNER;
    await assert.rejects(
      delayed.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
    await delayed.close();
  });

  await check("source edits and same-size same-mtime replacements invalidate previews", async () => {
    const changedPath = copyFixture("v2-character.json", "changed.json");
    const first = await service.previewImport({ ownerScope: OWNER, sourcePath: changedPath });
    fs.appendFileSync(changedPath, "\n");
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: first.previewToken }),
      codeIs("IMPORT_SOURCE_CHANGED"),
    );

    fs.copyFileSync(path.join(FIXTURES, "v2-character.json"), changedPath);
    const second = await service.previewImport({ ownerScope: OWNER, sourcePath: changedPath });
    const stat = fs.statSync(changedPath);
    const bytes = fs.readFileSync(changedPath);
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x7d ? 0x20 : 0x7d;
    fs.writeFileSync(changedPath, bytes);
    fs.utimesSync(changedPath, stat.atime, stat.mtime);
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: second.previewToken }),
      codeIs("IMPORT_SOURCE_CHANGED"),
    );
  });

  await check("the same preview token cannot commit twice concurrently", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    const settled = await Promise.allSettled([
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
    ]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
    assert(
      ["IMPORT_PREVIEW_IN_USE", "IMPORT_PREVIEW_EXPIRED"].includes(
        settled.find((entry) => entry.status === "rejected").reason.code,
      ),
    );
  });

  await check("a new service instance naturally invalidates process-local previews", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2Path });
    const restarted = makeService();
    await assert.rejects(
      restarted.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
    await restarted.close();
  });

  await check("preview cache capacity evicts the oldest unclaimed token", async () => {
    const bounded = makeService({ maxPreviews: 2 });
    const previews = [];
    for (let index = 0; index < 3; index += 1) {
      previews.push(await bounded.previewImport({ ownerScope: OWNER, sourcePath: v2Path }));
    }
    await assert.rejects(
      bounded.commitImport({ ownerScope: OWNER, previewToken: previews[0].previewToken }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
    const committed = await bounded.commitImport({
      ownerScope: OWNER,
      previewToken: previews[2].previewToken,
    });
    assert.equal(committed.revision.canonical.name, "Luna V2");
    await bounded.close();
  });

  await check("preview cache enforces its aggregate serialized-byte budget", async () => {
    const bounded = makeService({ maxPreviewBytes: 1 });
    await assert.rejects(
      bounded.previewImport({ ownerScope: OWNER, sourcePath: v2Path }),
      codeIs("IMPORT_PREVIEW_BUSY"),
    );
    assert.equal(bounded.previews.size, 0);
    assert.equal(bounded.previewBytes, 0);
    await bounded.close();
  });

  await check("destination capabilities are exact and one-shot", async () => {
    const outputPath = path.join(destinationRoot, "one-shot.json");
    const capability = await destinationWriter.approve(outputPath);
    await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: committedV2.revision.id,
      destinationCapability: capability,
    });
    await assert.rejects(
      service.exportCharacter({
        ownerScope: OWNER,
        revisionId: committedV2.revision.id,
        destinationCapability: capability,
      }),
      codeIs("EXPORT_DESTINATION_INVALID"),
    );
    assert.equal(fs.existsSync(outputPath), true);
  });
} finally {
  await service.close();
  await destinationWriter.close();
  await destinationBroker.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`character-worlds-import: ${checks} checks passed`);
