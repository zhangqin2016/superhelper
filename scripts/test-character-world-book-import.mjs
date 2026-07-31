#!/usr/bin/env node
// Character Worlds embedded character_book import contract (Phase 2, Task WB-2).
// Run: node scripts/test-character-world-book-import.mjs

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
const {
  parseCharacterCard,
} = require("../src/main/character-worlds/card-parser.js");
const {
  normalizeWorldBookCanonical,
} = require("../src/main/character-worlds/world-book-model.js");
const {
  MAX_WORLD_BOOK_LIMITS_VERSION,
  MAX_WORLD_BOOK_NAME_CHARS,
  MAX_WORLD_BOOK_KEYS_PER_ENTRY,
  WORLD_BOOK_SCHEMA_VERSION,
} = require("../src/main/character-worlds/constants.js");

const OWNER = "profile:local";
const FIXTURES = path.resolve("fixtures/character-worlds");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-world-book-import-"));
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

function tableColumns(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
}

function rowCount(db, table) {
  return db.get(`SELECT COUNT(*) AS count FROM ${table}`).count;
}

// The bounded JSON parser yields null-prototype objects; compare data only.
function jsonRound(value) {
  return JSON.parse(JSON.stringify(value));
}

// Minimal PNG builder (mirrors test-character-card-png.mjs) for embedding a
// card JSON payload in a tEXt chunk.
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PIXEL_ZLIB = Buffer.from([120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1]);

function crc32(buffer) {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function cardPng(cardJsonBytes) {
  const ihdr = pngChunk("IHDR", Buffer.from([
    0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0,
  ]));
  const text = pngChunk("tEXt", Buffer.concat([
    Buffer.from("chara", "latin1"),
    Buffer.from([0]),
    Buffer.from(cardJsonBytes.toString("base64"), "latin1"),
  ]));
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr,
    text,
    pngChunk("IDAT", PIXEL_ZLIB),
    pngChunk("IEND"),
  ]);
}

const DEFAULT_ACTIVATION = {
  constant: false,
  primaryKeys: [],
  secondaryKeys: [],
  selective: false,
  selectiveLogic: "and_any",
  useRegex: false,
  vectorized: false,
  caseSensitive: false,
  matchWholeWords: false,
  probability: 100,
  inclusionGroups: [],
  groupWeight: 100,
  prioritizeInclusion: false,
  useGroupScoring: false,
  characterFilter: { mode: "include", characterNames: [], characterTags: [] },
  generationTriggers: [],
  matchSources: [],
  delayMessages: 0,
  stickyMessages: 0,
  cooldownMessages: 0,
  forceState: "none",
  activateOnlyAfter: 0,
  greetingIndex: null,
  scanDepthMessages: 0,
  statefulMatch: "none",
};
const DEFAULT_INSERTION = {
  position: "before_character",
  depth: 4,
  role: "system",
  outletName: "",
  order: 100,
  priority: null,
  reverseDepth: false,
};
const EMPTY_DECORATORS = {
  directives: [],
  inert: [],
  applied: { activation: {}, insertion: {} },
};
const DEFAULT_RECURSION = {
  preventFurtherRecursion: false,
  excludeFromRecursion: false,
  delayUntilRecursion: false,
  recursionLevel: 0,
};

const store = new MessageStore(
  path.join(tmp, "messages.db"),
  path.join(tmp, "blobs"),
);
const repository = store.characterWorlds();
const sourceAuthority = new CharacterSourceAuthority({ roots: [sourceRoot] });
const destinationBroker = createTestDestinationBroker(destinationRoot);
const destinationWriter = new CharacterDestinationWriter({ broker: destinationBroker });
const clock = 1_800_000_000_000;

const service = new CharacterWorldsService({
  messageStore: store,
  repository,
  sourceAuthority,
  destinationWriter,
  resolveOwnerScope: async () => OWNER,
  now: () => clock,
  previewTtlMs: 60_000,
});

const v2BookBytes = fs.readFileSync(path.join(FIXTURES, "v2-character-book.json"));
const v3BookBytes = fs.readFileSync(path.join(FIXTURES, "v3-character-book.json"));
const parsedV2 = parseCharacterCard(v2BookBytes);
const parsedV3 = parseCharacterCard(v3BookBytes);

try {
  console.log("character-world-book-import:");

  await check("schema v9 pins the embedded book revision on character revisions", async () => {
    assert.equal(store.db.pragma("user_version"), 12);
    assert.ok(
      tableColumns(store.db, "character_revisions").includes("character_book_revision_id"),
      "missing character_revisions.character_book_revision_id",
    );
  });

  await check("V2 character_book fields map into the bounded §7.4 canonical shape", async () => {
    assert.equal(parsedV2.format, "v2_json");
    assert.ok(parsedV2.characterBook);
    const { canonical } = parsedV2.characterBook;
    assert.equal(canonical.schemaVersion, WORLD_BOOK_SCHEMA_VERSION);
    assert.equal(canonical.name, "Quiet Routes Atlas");
    assert.deepEqual(canonical.scanPolicy, {
      scanDepthMessages: 6,
      includeParticipantNames: true,
      tokenBudget: 400,
      recursive: false,
      maxRecursionSteps: 4,
      minActivations: 0,
      maxDepthMessages: 0,
    });
    assert.equal(canonical.entries.length, 2);
    assert.deepEqual(jsonRound(canonical.entries[0]), {
      id: "101",
      enabled: true,
      content: "Aurelia is a tide-locked port city.",
      activation: {
        ...DEFAULT_ACTIVATION,
        primaryKeys: ["aurelia", "tide-lock"],
        secondaryKeys: ["harbor"],
        selective: true,
        caseSensitive: true,
      },
      insertion: {
        ...DEFAULT_INSERTION,
        order: 42,
        priority: 7,
      },
      recursion: { ...DEFAULT_RECURSION },
      decorators: { ...EMPTY_DECORATORS },
      preservedDecorators: [],
      preservedExtensions: {},
      comment: "port lore memo",
    });
    assert.deepEqual(jsonRound(canonical.entries[1]), {
      id: "entry-1",
      enabled: true,
      content: "The beacon above the harbor never sleeps.",
      activation: { ...DEFAULT_ACTIVATION, constant: true, primaryKeys: ["beacon"] },
      insertion: { ...DEFAULT_INSERTION, position: "after_character" },
      recursion: { ...DEFAULT_RECURSION },
      decorators: { ...EMPTY_DECORATORS },
      preservedDecorators: [],
      preservedExtensions: {},
      vendor_flag: { keep: true },
    });
    // Unknown book-level fields stay inert inside the normalized document.
    assert.equal(canonical.description, "Vendor book description; kept as inert metadata.");
    assert.deepEqual(jsonRound(canonical.extensions), { vendor_book: { tier: 2 } });
  });

  await check("V3 extensions-style entry fields map into the normalized model", async () => {
    assert.equal(parsedV3.format, "v3_json");
    assert.ok(parsedV3.characterBook);
    const { canonical } = parsedV3.characterBook;
    assert.equal(canonical.name, "V3 Routes Atlas");
    assert.deepEqual(canonical.scanPolicy, {
      scanDepthMessages: 10,
      includeParticipantNames: true,
      tokenBudget: 512,
      recursive: true,
      maxRecursionSteps: 4,
      minActivations: 0,
      maxDepthMessages: 0,
    });
    assert.equal(canonical.entries.length, 1);
    const [entry] = canonical.entries;
    assert.equal(entry.id, "entry-luna");
    assert.equal(entry.enabled, true);
    assert.equal(entry.content, "Luna guards the night routes.");
    assert.deepEqual(entry.activation, {
      ...DEFAULT_ACTIVATION,
      primaryKeys: ["luna", "night route"],
      secondaryKeys: ["beacon"],
      selective: true,
      selectiveLogic: "and_all",
      matchWholeWords: true,
      probability: 65,
      inclusionGroups: ["routes"],
      groupWeight: 80,
      prioritizeInclusion: true,
      generationTriggers: ["summary"],
      delayMessages: 1,
      stickyMessages: 2,
      cooldownMessages: 3,
    });
    assert.deepEqual(entry.insertion, {
      ...DEFAULT_INSERTION,
      position: "at_depth",
      depth: 6,
      role: "user",
      order: 9,
    });
    assert.deepEqual(entry.recursion, {
      preventFurtherRecursion: true,
      excludeFromRecursion: true,
      delayUntilRecursion: true,
      recursionLevel: 0,
    });
    // The raw extensions object survives verbatim as inert preserved data.
    assert.equal(entry.preservedExtensions.automation_id, "vendor-auto-1");
    assert.equal(entry.preservedExtensions.display_index, 5);
    assert.equal(entry.preservedExtensions.probability, 65);
  });

  await check("the compatibility report classifies mapped and inert book fields", async () => {
    const report = parsedV2.compatibility;
    assert.ok(report.supported.includes("/data/character_book/entries"));
    assert.ok(report.supported.includes("/data/character_book/scan_depth"));
    assert.ok(report.supported.includes("/data/character_book/entries/0/keys"));
    assert.ok(report.supported.includes("/data/character_book/entries/0/secondary_keys"));
    assert.ok(report.supported.includes("/data/character_book/entries/0/insertion_order"));
    assert.ok(report.supported.includes("/data/character_book/entries/1/position"));
    for (const inert of [
      "/data/character_book/description",
      "/data/character_book/extensions/vendor_book/tier",
      "/data/character_book/entries/0/comment",
      "/data/character_book/entries/1/vendor_flag/keep",
    ]) {
      assert.ok(report.preservedInert.includes(inert), `missing inert ${inert}`);
    }
    const v3Report = parsedV3.compatibility;
    assert.ok(v3Report.supported.includes("/data/character_book/entries/0/extensions/probability"));
    assert.ok(v3Report.supported.includes("/data/character_book/entries/0/extensions/selectiveLogic"));
    assert.ok(v3Report.preservedInert.includes("/data/character_book/entries/0/extensions/automation_id"));
    assert.ok(v3Report.preservedInert.includes("/data/character_book/entries/0/extensions/display_index"));
  });

  await check("parse summaries report entry, supported, and inert counts", async () => {
    assert.deepEqual(parsedV2.characterBook.summary, {
      name: "Quiet Routes Atlas",
      entryCount: 2,
      supportedFields: 20,
      inertFields: 4,
    });
    assert.deepEqual(parsedV3.characterBook.summary, {
      name: "V3 Routes Atlas",
      entryCount: 1,
      supportedFields: 30,
      inertFields: 2,
    });
  });

  await check("V1 cards never interpret a character_book key as a book", async () => {
    const v1 = parseCharacterCard(Buffer.from(JSON.stringify({
      name: "Legacy One",
      description: "legacy",
      personality: "calm",
      scenario: "dock",
      character_book: { name: "Stray Book", entries: [] },
    })));
    assert.equal(v1.format, "v1_json");
    assert.equal(v1.characterBook, null);
    assert.ok(v1.compatibility.preservedInert.includes("/character_book/name"));
  });

  await check("a non-object character_book is ignored-invalid, never fatal", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    card.data.character_book = "not-a-book";
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card)));
    assert.equal(parsed.characterBook, null);
    assert.deepEqual(parsed.compatibility.ignoredInvalid, ["/data/character_book"]);
  });

  await check("unnamed books fall back to a deterministic character-derived name", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    delete card.data.character_book.name;
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card)));
    assert.equal(parsed.characterBook.canonical.name, "Lorekeeper V2 embedded book");
    const again = parseCharacterCard(Buffer.from(JSON.stringify(card)));
    assert.equal(again.characterBook.canonical.name, "Lorekeeper V2 embedded book");
  });

  await check("hostile books fail closed at parse time with precise world-book codes", async () => {
    const withBook = (mutate) => {
      const card = JSON.parse(v2BookBytes.toString("utf8"));
      mutate(card.data.character_book);
      return Buffer.from(JSON.stringify(card));
    };
    assert.throws(
      () => parseCharacterCard(withBook((book) => {
        book.entries = [{ id: "same", content: "a" }, { id: "same", content: "b" }];
      })),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID" && error.entryId === "same",
    );
    assert.throws(
      () => parseCharacterCard(withBook((book) => {
        book.name = "n".repeat(MAX_WORLD_BOOK_NAME_CHARS + 1);
      })),
      (error) => error.code === "WORLD_BOOK_LIMIT_EXCEEDED"
        && error.limitKind === "nameChars"
        && error.limit === MAX_WORLD_BOOK_NAME_CHARS,
    );
    assert.throws(
      () => parseCharacterCard(withBook((book) => {
        book.entries = [{
          id: "flood",
          content: "x",
          keys: Array.from({ length: MAX_WORLD_BOOK_KEYS_PER_ENTRY + 1 }, (_, index) => `k${index}`),
        }];
      })),
      (error) => error.code === "WORLD_BOOK_LIMIT_EXCEEDED"
        && error.limitKind === "activationKeys"
        && error.limit === MAX_WORLD_BOOK_KEYS_PER_ENTRY,
    );
    assert.throws(
      () => parseCharacterCard(withBook((book) => {
        book.entries = "not-an-array";
      })),
      codeIs("WORLD_BOOK_DATA_INVALID"),
    );
  });

  await check("executable-sounding unknown book keys defer to the final walk", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    card.data.character_book.script = "echo book-level";
    card.data.character_book.quickreply = { reply: "object-value" };
    card.data.character_book.entries[0].stscript = "echo entry-level";
    card.data.character_book.entries[0].plugin = { nested: true };
    card.data.character_book.entries[0].extensions = {
      stscript: "echo ext-level",
      safe: 1,
    };
    card.data.character_book.entries[1].vendor_flag.script = "nested-executable";
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card)));
    assert.ok(parsed.characterBook, "safe parts of the card still import");
    for (const pointer of [
      "/data/character_book/script",
      "/data/character_book/quickreply",
      "/data/character_book/entries/0/stscript",
      "/data/character_book/entries/0/plugin",
      "/data/character_book/entries/0/extensions/stscript",
      "/data/character_book/entries/1/vendor_flag/script",
    ]) {
      assert.ok(
        parsed.compatibility.rejectedExecutable.includes(pointer),
        `missing rejectedExecutable ${pointer}`,
      );
      assert.ok(!parsed.compatibility.preservedInert.includes(pointer));
    }
    const { canonical } = parsed.characterBook;
    assert.ok(!("script" in canonical) && !("quickreply" in canonical));
    assert.ok(!("stscript" in canonical.entries[0]) && !("plugin" in canonical.entries[0]));
    assert.deepEqual(jsonRound(canonical.entries[0].preservedExtensions), { safe: 1 });
    assert.deepEqual(jsonRound(canonical.entries[1].vendor_flag), { keep: true });
    // Non-executable unknown data is still inert-preserved and reported.
    assert.ok(
      parsed.compatibility.preservedInert.includes(
        "/data/character_book/entries/0/extensions/safe",
      ),
    );
    assert.equal(canonical.entries.length, 2);
    assert.equal(canonical.entries[0].activation.primaryKeys[0], "aurelia");
  });

  await check("selectiveLogic strings validate against the enum", async () => {
    const withLogic = (value) => {
      const card = JSON.parse(v2BookBytes.toString("utf8"));
      card.data.character_book.entries = [{
        id: "logic",
        keys: ["a"],
        content: "x",
        selectiveLogic: value,
      }];
      return parseCharacterCard(Buffer.from(JSON.stringify(card)));
    };
    const invalid = withLogic("xor");
    assert.equal(
      invalid.characterBook.canonical.entries[0].activation.selectiveLogic,
      "and_any",
    );
    assert.ok(
      invalid.compatibility.ignoredInvalid.includes(
        "/data/character_book/entries/0/selectiveLogic",
      ),
    );
    assert.ok(
      !invalid.compatibility.supported.includes(
        "/data/character_book/entries/0/selectiveLogic",
      ),
    );
    const valid = withLogic("not_all");
    assert.equal(
      valid.characterBook.canonical.entries[0].activation.selectiveLogic,
      "not_all",
    );
    assert.ok(
      valid.compatibility.supported.includes(
        "/data/character_book/entries/0/selectiveLogic",
      ),
    );
  });

  await check("useProbability === false forces probability to 100", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    card.data.character_book.entries = [
      { id: "a", keys: ["a"], content: "x", probability: 30, useProbability: false },
      {
        id: "b",
        keys: ["b"],
        content: "x",
        extensions: { probability: 30, useProbability: false },
      },
      { id: "c", keys: ["c"], content: "x", probability: 30, useProbability: true },
    ];
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card)));
    const [a, b, c] = parsed.characterBook.canonical.entries;
    assert.equal(a.activation.probability, 100);
    assert.equal(b.activation.probability, 100);
    assert.equal(c.activation.probability, 30);
  });

  await check("SillyTavern numeric positions 0-7 map to the §7.4 enum", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    card.data.character_book.entries = [0, 1, 2, 3, 4, 5, 6, 7].map((position) => ({
      id: `pos-${position}`,
      keys: ["a"],
      content: "x",
      position,
    }));
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card)));
    assert.deepEqual(
      parsed.characterBook.canonical.entries.map((entry) => entry.insertion.position),
      [
        "before_character",
        "after_character",
        "author_note_top",
        "author_note_bottom",
        "at_depth",
        "before_examples",
        "after_examples",
        "outlet",
      ],
    );
  });

  await check("entry top-level spellings win over extensions on conflicts", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    card.data.character_book.entries = [{
      id: "conflict",
      keys: ["a"],
      content: "x",
      constant: false,
      probability: 20,
      extensions: { constant: true, probability: 80 },
    }];
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card)));
    const [entry] = parsed.characterBook.canonical.entries;
    assert.equal(entry.activation.constant, false);
    assert.equal(entry.activation.probability, 20);
    assert.ok(
      parsed.compatibility.supported.includes("/data/character_book/entries/0/constant"),
    );
    // The shadowed extensions spelling is preserved but inert, never applied.
    assert.ok(
      parsed.compatibility.preservedInert.includes(
        "/data/character_book/entries/0/extensions/constant",
      ),
    );
    assert.ok(!parsed.compatibility.supported.includes(
      "/data/character_book/entries/0/extensions/constant",
    ));
    assert.equal(entry.preservedExtensions.constant, true);
    assert.equal(entry.preservedExtensions.probability, 80);
  });

  await check("numeric and string entry ids collide as duplicates", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    card.data.character_book.entries = [
      { id: 1, keys: ["a"], content: "x" },
      { id: "1", keys: ["b"], content: "y" },
    ];
    assert.throws(
      () => parseCharacterCard(Buffer.from(JSON.stringify(card))),
      (error) => error.code === "WORLD_BOOK_DATA_INVALID" && error.entryId === "1",
    );
  });

  await check("explicit null numerics fall back to field defaults", async () => {
    const normalized = normalizeWorldBookCanonical({
      schemaVersion: 1,
      name: "Null Book",
      entries: [{
        id: "n",
        content: "x",
        activation: { probability: null, groupWeight: null, delayMessages: null },
        insertion: { depth: null, order: null, priority: null },
      }],
      scanPolicy: { scanDepthMessages: null, tokenBudget: null },
    });
    const [entry] = normalized.entries;
    assert.equal(entry.activation.probability, 100);
    assert.equal(entry.activation.groupWeight, 100);
    assert.equal(entry.activation.delayMessages, 0);
    assert.equal(entry.insertion.depth, 4);
    assert.equal(entry.insertion.order, 100);
    assert.equal(entry.insertion.priority, null);
    assert.equal(normalized.scanPolicy.scanDepthMessages, 8);
    assert.equal(normalized.scanPolicy.tokenBudget, 0);
  });

  let committedBook;
  let currentBookRevisionId;
  const v2BookPath = copyFixture("v2-character-book.json");

  await check("preview reports the embedded book summary without side effects", async () => {
    const beforeBooks = rowCount(store.db, "world_book_entities");
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2BookPath });
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.characterBook, {
      name: "Quiet Routes Atlas",
      entryCount: 2,
      supportedFields: 20,
      inertFields: 4,
    });
    assert.equal(rowCount(store.db, "world_book_entities"), beforeBooks);
    assert.equal(repository.listWorldBooks(OWNER).length, 0);
  });

  await check("commit creates the book revision and pins it in the same transaction", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2BookPath });
    committedBook = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    const link = committedBook.revision.characterBookRevisionId;
    assert.ok(link, "characterBookRevisionId must be pinned");
    assert.deepEqual(committedBook.characterBook, {
      entityId: committedBook.characterBook.entityId,
      revisionId: link,
      reused: false,
    });
    assert.equal(
      store.db.get(
        "SELECT character_book_revision_id AS link FROM character_revisions WHERE id = ?",
        committedBook.revision.id,
      ).link,
      link,
    );
    const bookRevision = repository.getWorldBookRevision(OWNER, link);
    assert.ok(bookRevision);
    assert.equal(bookRevision.id, link);
    assert.equal(bookRevision.worldBookId, committedBook.characterBook.entityId);
    assert.equal(bookRevision.name, "Quiet Routes Atlas");
    assert.deepEqual(bookRevision.canonical, jsonRound(parsedV2.characterBook.canonical));
    assert.equal(bookRevision.source.kind, "imported");
    assert.equal(bookRevision.source.embedding, "character_book");
    assert.equal(repository.listWorldBooks(OWNER).length, 1);
  });

  await check("edits keep the book pin on the next character revision", async () => {
    const pin = committedBook.revision.characterBookRevisionId;
    const edited = repository.createRevision({
      ownerScope: OWNER,
      entityId: committedBook.entity.id,
      baseRevisionId: committedBook.revision.id,
      canonical: {
        ...committedBook.revision.canonical,
        description: "Edited after import; the book stays linked.",
      },
      source: committedBook.revision.source,
    });
    assert.notEqual(edited.id, committedBook.revision.id);
    assert.equal(edited.characterBookRevisionId, pin);
    assert.equal(repository.getRevision(OWNER, edited.id).characterBookRevisionId, pin);
    assert.equal(
      store.db.get(
        "SELECT character_book_revision_id AS link FROM character_revisions WHERE id = ?",
        edited.id,
      ).link,
      pin,
    );
    const editedAgain = repository.createRevision({
      ownerScope: OWNER,
      entityId: committedBook.entity.id,
      baseRevisionId: edited.id,
      canonical: { ...edited.canonical, description: "Second edit." },
      source: committedBook.revision.source,
    });
    assert.equal(editedAgain.characterBookRevisionId, pin);
    currentBookRevisionId = editedAgain.id;
  });

  await check("exact re-import reuses the character and never re-creates the book", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v2BookPath });
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.equal(committed.entity.id, committedBook.entity.id);
    // Exact reuse returns the entity's current (edited) revision; the source
    // match identifies the originally imported revision.
    assert.equal(committed.revision.id, currentBookRevisionId);
    assert.equal(committed.matchedSourceRevisionId, committedBook.revision.id);
    assert.equal(committed.revision.characterBookRevisionId, committedBook.revision.characterBookRevisionId);
    assert.equal(rowCount(store.db, "world_book_entities"), 1);
    assert.equal(rowCount(store.db, "world_book_revisions"), 1);
  });

  await check("an identical embedded book dedups to the same book revision across imports", async () => {
    const twinPath = path.join(sourceRoot, "v2-character-book-twin.json");
    const twin = JSON.parse(v2BookBytes.toString("utf8"));
    twin.data.name = "Lorekeeper V2 Twin";
    twin.data.description = "A different character carrying the same book.";
    fs.writeFileSync(twinPath, JSON.stringify(twin));
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: twinPath });
    assert.equal(preview.duplicates.exact, null);
    assert.equal(preview.duplicates.canonical, null);
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.notEqual(committed.entity.id, committedBook.entity.id);
    assert.equal(
      committed.revision.characterBookRevisionId,
      committedBook.revision.characterBookRevisionId,
    );
    assert.deepEqual(committed.characterBook, {
      entityId: committedBook.characterBook.entityId,
      revisionId: committedBook.revision.characterBookRevisionId,
      reused: true,
    });
    assert.equal(rowCount(store.db, "world_book_entities"), 1);
    assert.equal(rowCount(store.db, "world_book_revisions"), 1);
    assert.equal(repository.listCharacters(OWNER).length, 2);
  });

  await check("cards without a character_book behave exactly as before", async () => {
    const plainPath = copyFixture("v2-character.json");
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: plainPath });
    assert.equal(preview.characterBook, null);
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.equal(committed.characterBook, null);
    assert.equal(committed.revision.characterBookRevisionId, null);
    assert.equal(rowCount(store.db, "world_book_entities"), 1);
  });

  await check("a failing character insert rolls the book revision back atomically", async () => {
    const before = {
      books: rowCount(store.db, "world_book_entities"),
      bookRevisions: rowCount(store.db, "world_book_revisions"),
      characters: rowCount(store.db, "character_entities"),
      revisions: rowCount(store.db, "character_revisions"),
    };
    const twinCard = JSON.parse(fs.readFileSync(v2BookPath).toString("utf8"));
    twinCard.data.name = "Rollback Probe Unique";
    const originalBytes = Buffer.from(JSON.stringify(twinCard));
    const originalHash = sha256(originalBytes);
    const parsed = parseCharacterCard(originalBytes);
    const input = {
      ownerScope: OWNER,
      canonical: parsed.canonical,
      source: {
        kind: "imported",
        format: parsed.format,
        container: "json",
        original: {
          hash: originalHash,
          bytes: originalBytes.length,
          mime: "application/json",
          purpose: "character-card-original",
        },
      },
      assets: [{
        purpose: "character-card-original",
        mime: "application/json",
        data: originalBytes,
      }],
      characterBook: {
        canonical: parsed.characterBook.canonical,
        source: {
          kind: "imported",
          format: parsed.format,
          container: "json",
          embedding: "character_book",
        },
      },
    };

    const sabotaged = Object.create(repository);
    const sabotagedDb = Object.create(repository.db);
    sabotagedDb.run = (sql, ...args) => {
      if (String(sql).includes("INSERT INTO character_entities")) {
        throw Object.assign(new Error("transient"), { code: "TRANSIENT_INSERT_FAILURE" });
      }
      return repository.db.run(sql, ...args);
    };
    sabotaged.db = sabotagedDb;
    assert.throws(
      () => sabotaged.importCharacter(input),
      codeIs("TRANSIENT_INSERT_FAILURE"),
    );
    assert.equal(rowCount(store.db, "world_book_entities"), before.books);
    assert.equal(rowCount(store.db, "world_book_revisions"), before.bookRevisions);
    assert.equal(rowCount(store.db, "character_entities"), before.characters);
    assert.equal(rowCount(store.db, "character_revisions"), before.revisions);
    assert.equal(store.blobs.exists(originalHash), false, "unreferenced new blob is rolled back");

    // The same input commits cleanly once the failure is gone.
    const committed = repository.importCharacter(input);
    assert.ok(committed.revision.characterBookRevisionId);
    assert.equal(rowCount(store.db, "character_entities"), before.characters + 1);
  });

  await check("hostile books are rejected through the worker import path", async () => {
    const floodCard = JSON.parse(v2BookBytes.toString("utf8"));
    floodCard.data.name = "Hostile Book Flood";
    floodCard.data.character_book.entries = [
      { id: "same", content: "a" },
      { id: "same", content: "b" },
    ];
    const floodPath = path.join(sourceRoot, "hostile-book.json");
    fs.writeFileSync(floodPath, JSON.stringify(floodCard));
    const before = rowCount(store.db, "character_entities");
    await assert.rejects(
      service.previewImport({ ownerScope: OWNER, sourcePath: floodPath }),
      (error) => error?.code === "WORLD_BOOK_DATA_INVALID" && error.entryId === "same",
    );
    assert.equal(rowCount(store.db, "character_entities"), before);

    const limitCard = JSON.parse(v2BookBytes.toString("utf8"));
    limitCard.data.name = "Hostile Book Name";
    limitCard.data.character_book.name = "n".repeat(MAX_WORLD_BOOK_NAME_CHARS + 1);
    const limitPath = path.join(sourceRoot, "hostile-book-name.json");
    fs.writeFileSync(limitPath, JSON.stringify(limitCard));
    await assert.rejects(
      service.previewImport({ ownerScope: OWNER, sourcePath: limitPath }),
      (error) => error?.code === "WORLD_BOOK_LIMIT_EXCEEDED"
        && error.limitKind === "nameChars"
        && error.limitsVersion === MAX_WORLD_BOOK_LIMITS_VERSION
        && error.limit === MAX_WORLD_BOOK_NAME_CHARS,
    );
    assert.equal(rowCount(store.db, "character_entities"), before);

    const keysCard = JSON.parse(v2BookBytes.toString("utf8"));
    keysCard.data.name = "Hostile Book Keys";
    keysCard.data.character_book.entries = [{
      id: "flood",
      content: "x",
      keys: Array.from({ length: MAX_WORLD_BOOK_KEYS_PER_ENTRY + 1 }, (_, index) => `k${index}`),
    }];
    const keysPath = path.join(sourceRoot, "hostile-book-keys.json");
    fs.writeFileSync(keysPath, JSON.stringify(keysCard));
    await assert.rejects(
      service.previewImport({ ownerScope: OWNER, sourcePath: keysPath }),
      (error) => error?.code === "WORLD_BOOK_LIMIT_EXCEEDED"
        && error.limitKind === "activationKeys"
        && error.limitsVersion === MAX_WORLD_BOOK_LIMITS_VERSION
        && error.limit === MAX_WORLD_BOOK_KEYS_PER_ENTRY,
    );
    assert.equal(rowCount(store.db, "character_entities"), before);
  });

  await check("executable book keys import inert: reported, never stored, never fatal", async () => {
    const card = JSON.parse(v2BookBytes.toString("utf8"));
    card.data.name = "Executable Book Carrier";
    card.data.character_book.script = "echo book-level";
    card.data.character_book.entries[0].stscript = "echo entry-level";
    card.data.character_book.entries[1].quickreply = { reply: "object" };
    const executablePath = path.join(sourceRoot, "executable-book.json");
    fs.writeFileSync(executablePath, JSON.stringify(card));
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: executablePath });
    assert.equal(preview.ok, true);
    assert.equal(preview.characterBook.entryCount, 2);
    for (const pointer of [
      "/data/character_book/script",
      "/data/character_book/entries/0/stscript",
      "/data/character_book/entries/1/quickreply",
    ]) {
      assert.ok(
        preview.compatibility.rejectedExecutable.includes(pointer),
        `missing rejectedExecutable ${pointer}`,
      );
    }
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.ok(committed.revision.characterBookRevisionId);
    const bookRevision = repository.getWorldBookRevision(
      OWNER,
      committed.revision.characterBookRevisionId,
    );
    const canonicalJson = JSON.stringify(bookRevision.canonical);
    assert.ok(!canonicalJson.includes("stscript"));
    assert.ok(!canonicalJson.includes("quickreply"));
    assert.ok(!canonicalJson.includes("echo book-level"));
    assert.equal(bookRevision.canonical.entries[0].activation.primaryKeys[0], "aurelia");
    assert.equal(bookRevision.canonical.entries[1].activation.constant, true);
  });

  await check("V3 embedded books import end to end through the service", async () => {
    const v3Path = copyFixture("v3-character-book.json");
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: v3Path });
    assert.equal(preview.format, "v3_json");
    assert.equal(preview.characterBook.entryCount, 1);
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    const bookRevision = repository.getWorldBookRevision(
      OWNER,
      committed.revision.characterBookRevisionId,
    );
    assert.equal(bookRevision.name, "V3 Routes Atlas");
    assert.equal(bookRevision.canonical.entries[0].activation.selectiveLogic, "and_all");
    assert.equal(bookRevision.canonical.entries[0].insertion.position, "at_depth");
  });

  await check("a PNG container carries an embedded book through the same pipeline", async () => {
    const pngPath = path.join(sourceRoot, "v2-character-book.png");
    fs.writeFileSync(pngPath, cardPng(v2BookBytes));
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: pngPath });
    assert.equal(preview.ok, true);
    assert.equal(preview.container, "png");
    assert.deepEqual(preview.characterBook, {
      name: "Quiet Routes Atlas",
      entryCount: 2,
      supportedFields: 20,
      inertFields: 4,
    });
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
      duplicateResolution: "create_copy",
    });
    assert.ok(committed.revision.characterBookRevisionId);
    const bookRevision = repository.getWorldBookRevision(
      OWNER,
      committed.revision.characterBookRevisionId,
    );
    assert.equal(bookRevision.name, "Quiet Routes Atlas");
    assert.deepEqual(bookRevision.canonical, jsonRound(parsedV2.characterBook.canonical));
    // The container is part of the book's provenance envelope, so the same
    // book arriving from a different container is a distinct revision.
    assert.equal(committed.characterBook.reused, false);
    assert.equal(bookRevision.source.container, "png");
  });

  await check("book dedup never pins a revision whose entity is archived", async () => {
    const archivedEntityId = committedBook.characterBook.entityId;
    const archivedRevisionId = committedBook.revision.characterBookRevisionId;
    const archived = repository.archiveWorldBook(OWNER, archivedEntityId);
    assert.ok(archived.archivedAt);

    const twinPath = path.join(sourceRoot, "v2-character-book-second-twin.json");
    const twin = JSON.parse(v2BookBytes.toString("utf8"));
    twin.data.name = "Lorekeeper V2 Second Twin";
    twin.data.description = "The same book after the original entity was archived.";
    fs.writeFileSync(twinPath, JSON.stringify(twin));
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: twinPath });
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    assert.equal(committed.characterBook.reused, false);
    assert.notEqual(committed.characterBook.entityId, archivedEntityId);
    assert.notEqual(committed.characterBook.revisionId, archivedRevisionId);
    assert.equal(committed.revision.characterBookRevisionId, committed.characterBook.revisionId);
    assert.equal(
      repository.getWorldBook(OWNER, committed.characterBook.entityId).archivedAt,
      null,
    );
    assert.ok(repository.getWorldBook(OWNER, archivedEntityId).archivedAt);

    // A later import of the same book dedups to the live second-twin
    // revision; the archived entity is never re-pinned.
    const thirdPath = path.join(sourceRoot, "v2-character-book-third-twin.json");
    fs.writeFileSync(thirdPath, JSON.stringify({
      ...twin,
      data: { ...twin.data, name: "Lorekeeper V2 Third Twin" },
    }));
    const thirdPreview = await service.previewImport({ ownerScope: OWNER, sourcePath: thirdPath });
    const third = await service.commitImport({
      ownerScope: OWNER,
      previewToken: thirdPreview.previewToken,
    });
    assert.equal(third.characterBook.reused, true);
    assert.equal(third.characterBook.revisionId, committed.characterBook.revisionId);
  });
} finally {
  await service.close();
  await destinationWriter.close();
  await destinationBroker.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`character-world-book-import: ${checks} checks passed`);
