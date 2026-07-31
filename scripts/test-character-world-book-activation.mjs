// Character Worlds world-book activation resolver contract (Phase 2, Task WB-3).
// Run: node scripts/test-character-world-book-activation.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS,
  WORLD_BOOK_MATCHING_POLICY_VERSION,
} = require("../src/main/character-worlds/constants.js");
const {
  normalizeWorldBookCanonical,
} = require("../src/main/character-worlds/world-book-model.js");
const {
  buildScanCorpus,
} = require("../src/main/character-worlds/world-book-corpus.js");
const {
  resolveWorldBookActivation,
} = require("../src/main/character-worlds/world-book-activation.js");

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function makeEntry(id, content, opts = {}) {
  return {
    id,
    content,
    ...(opts.enabled === false ? { enabled: false } : {}),
    ...(opts.activation ? { activation: opts.activation } : {}),
    ...(opts.insertion ? { insertion: opts.insertion } : {}),
    ...(opts.recursion ? { recursion: opts.recursion } : {}),
  };
}

function makeBook(entries, scanPolicy = {}) {
  return normalizeWorldBookCanonical({
    schemaVersion: 1,
    name: "Resolver Book",
    entries,
    scanPolicy,
  });
}

function msg(seq, text, role = "user", speakerName = role === "user" ? "User" : "Luna") {
  return { seq, role, speakerName, text };
}

function makeCorpus({ messages = [], sources = {}, scanPolicy = {}, limits = {} } = {}) {
  return buildScanCorpus({ messages, matchingSources: sources, scanPolicy, limits });
}

function resolveInput(overrides = {}) {
  return {
    bookRevision: makeBook([]),
    corpus: makeCorpus({ messages: [msg(1, "hello")] }),
    checkpoint: null,
    seedIdentity: { ownerScope: "profile:local", sessionId: "session-1", turnId: "turn-1" },
    compatibilityProfile: "lily-character-compat-1",
    generationContext: { characterName: "Luna", characterTags: ["crew"], kind: "normal" },
    budget: {},
    ...overrides,
  };
}

const run = (overrides) => resolveWorldBookActivation(resolveInput(overrides));
const activatedIds = (result) => result.activated.map((entry) => entry.entryId);
const omittedFor = (result, entryId) => result.omitted.find((entry) => entry.entryId === entryId);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- corpus ----

check("corpus keeps only the newest scanDepthMessages canonical messages", () => {
  const corpus = makeCorpus({
    messages: [msg(1, "oldest"), msg(2, "middle"), msg(3, "newest")],
    scanPolicy: { scanDepthMessages: 2 },
  });
  const messageUnits = corpus.units.filter((unit) => unit.kind === "message");
  assert.deepEqual(messageUnits.map((unit) => unit.seq), [2, 3]);
  assert.equal(messageUnits.every((unit) => !unit.extended), true);
  assert.equal(corpus.stats.primaryMessages, 2);
  assert.equal(corpus.stats.sequenceNow, 3);
});

check("corpus prefixes a stable participant separator and display name", () => {
  const corpus = makeCorpus({ messages: [msg(7, "hi there", "user", "Kestrel")] });
  const [unit] = corpus.units;
  assert.match(unit.matchTextCs, /^⟦user:Kestrel⟧ /);
  assert.ok(unit.matchTextCs.endsWith("hi there"));
  // Original text is preserved unprefixed; only the matching copy is prefixed.
  assert.equal(unit.text, "hi there");
  assert.equal(unit.insertable, true);
  // The participant name itself is matchable (it is part of the matching copy).
  const result = run({
    bookRevision: makeBook([makeEntry("name-key", "by name", {
      activation: { primaryKeys: ["Kestrel"] },
    })]),
    corpus,
  });
  assert.deepEqual(activatedIds(result), ["name-key"]);
});

check("patterns cannot match across message boundaries", () => {
  const corpus = makeCorpus({ messages: [msg(1, "abc"), msg(2, "def")] });
  const result = run({
    bookRevision: makeBook([makeEntry("span", "spans", {
      activation: { primaryKeys: ["abcdef"] },
    })]),
    corpus,
  });
  assert.deepEqual(activatedIds(result), []);
});

check("matching copy is NFC-normalized and case-folded, original preserved", () => {
  const nfd = "café HARBOR";
  const corpus = makeCorpus({ messages: [msg(1, nfd)] });
  const [unit] = corpus.units;
  assert.equal(unit.text, nfd);
  assert.ok(unit.matchTextCs.includes("café HARBOR"));
  assert.ok(unit.matchTextCi.includes("café harbor"));
  const result = run({
    bookRevision: makeBook([makeEntry("nfc", "matched", {
      activation: { primaryKeys: ["café harbor"] },
    })]),
    corpus,
  });
  assert.deepEqual(activatedIds(result), ["nfc"]);
});

check("matching sources are matchable opt-ins but never insertable", () => {
  const corpus = makeCorpus({
    messages: [msg(1, "plain chat")],
    sources: { description: "the orbital docks", scenario: "a quiet tide" },
  });
  const sourceUnits = corpus.units.filter((unit) => unit.kind === "source");
  assert.deepEqual(sourceUnits.map((unit) => unit.scope), ["description", "scenario"]);
  assert.equal(sourceUnits.every((unit) => unit.insertable === false), true);

  const optedIn = run({
    bookRevision: makeBook([makeEntry("src", "from source", {
      activation: { primaryKeys: ["orbital"], matchSources: ["description"] },
    })]),
    corpus,
  });
  assert.deepEqual(activatedIds(optedIn), ["src"]);
  assert.equal(optedIn.activated[0].sourceScope, "description");

  const notOptedIn = run({
    bookRevision: makeBook([makeEntry("src", "from source", {
      activation: { primaryKeys: ["orbital"] },
    })]),
    corpus,
  });
  assert.deepEqual(activatedIds(notOptedIn), []);
});

check("corpus character budget truncates oldest messages deterministically", () => {
  const limited = makeCorpus({
    messages: [msg(1, "a".repeat(100)), msg(2, "b".repeat(100)), msg(3, "cc")],
    limits: { maxCorpusChars: 120 },
  });
  const seqs = limited.units.filter((unit) => unit.kind === "message").map((unit) => unit.seq);
  assert.deepEqual(seqs, [3]);
  assert.equal(limited.stats.truncated, true);
  assert.ok(limited.stats.corpusChars <= 120);
  const replay = makeCorpus({
    messages: [msg(1, "a".repeat(100)), msg(2, "b".repeat(100)), msg(3, "cc")],
    limits: { maxCorpusChars: 120 },
  });
  assert.deepEqual(replay, limited);
});

// ------------------------------------------------------------- constants ----

check("constant entries activate without any key match; disabled entries never do", () => {
  const result = run({
    bookRevision: makeBook([
      makeEntry("const-on", "always", { activation: { constant: true } }),
      makeEntry("const-off", "never", { enabled: false, activation: { constant: true } }),
    ]),
    corpus: makeCorpus({ messages: [] }),
  });
  assert.deepEqual(activatedIds(result), ["const-on"]);
  assert.equal(result.activated[0].reason, "constant");
  assert.equal(result.activated[0].sourceScope, "constant");
  assert.equal(result.activated[0].recursionLevel, 0);
  assert.match(result.activated[0].contentHash, /^sha256:[a-f0-9]{64}$/);
});

// ------------------------------------------------------------ selective -----

check("selective secondary logic honors and_any / and_all / not_any / not_all", () => {
  const corpus = makeCorpus({ messages: [msg(1, "the harbor slept through the storm")] });
  const entryWith = (selectiveLogic, secondaryKeys) => makeEntry("sel", "selective", {
    activation: { primaryKeys: ["harbor"], secondaryKeys, selective: true, selectiveLogic },
  });
  const runLogic = (selectiveLogic, secondaryKeys) => run({
    bookRevision: makeBook([entryWith(selectiveLogic, secondaryKeys)]),
    corpus,
  });

  assert.deepEqual(activatedIds(runLogic("and_any", ["storm"])), ["sel"]);
  assert.deepEqual(activatedIds(runLogic("and_any", ["lantern"])), []);
  assert.equal(omittedFor(runLogic("and_any", ["lantern"]), "sel").reason, "selective_logic");

  assert.deepEqual(activatedIds(runLogic("and_all", ["storm", "slept"])), ["sel"]);
  assert.deepEqual(activatedIds(runLogic("and_all", ["storm", "lantern"])), []);

  assert.deepEqual(activatedIds(runLogic("not_any", ["lantern"])), ["sel"]);
  assert.deepEqual(activatedIds(runLogic("not_any", ["storm"])), []);

  assert.deepEqual(activatedIds(runLogic("not_all", ["storm", "lantern"])), ["sel"]);
  assert.deepEqual(activatedIds(runLogic("not_all", ["storm", "slept"])), []);
});

// ---------------------------------------------------- case and whole word ---

check("caseSensitive keys only match exact case", () => {
  const corpus = makeCorpus({ messages: [msg(1, "the kepler archives")] });
  const sensitive = run({
    bookRevision: makeBook([makeEntry("cs", "case", {
      activation: { primaryKeys: ["Kepler"], caseSensitive: true },
    })]),
    corpus,
  });
  assert.deepEqual(activatedIds(sensitive), []);
  const insensitive = run({
    bookRevision: makeBook([makeEntry("ci", "case", {
      activation: { primaryKeys: ["Kepler"] },
    })]),
    corpus,
  });
  assert.deepEqual(activatedIds(insensitive), ["ci"]);
});

check("whole-word matching uses the documented boundary rule for latin keys", () => {
  const book = makeBook([makeEntry("ww", "whole word", {
    activation: { primaryKeys: ["port"], matchWholeWords: true },
  })]);
  assert.deepEqual(activatedIds(run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(1, "the airport lounge")] }),
  })), []);
  const matched = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(1, "the Port, at dawn")] }),
  });
  assert.deepEqual(activatedIds(matched), ["ww"]);
  assert.equal(matched.activated[0].matchedKeyCount, 1);
});

check("CJK keys are exempt from whole-word boundaries", () => {
  const result = run({
    bookRevision: makeBook([makeEntry("cjk", "magic", {
      activation: { primaryKeys: ["魔法"], matchWholeWords: true },
    })]),
    corpus: makeCorpus({ messages: [msg(1, "魔法使いの夜")] }),
  });
  assert.deepEqual(activatedIds(result), ["cjk"]);
});

// ------------------------------------------------------------ probability ---

check("probability 0 never activates and probability 100 always activates", () => {
  const corpus = makeCorpus({ messages: [msg(1, "dice on the table")] });
  const result = run({
    bookRevision: makeBook([
      makeEntry("p0", "never", { activation: { primaryKeys: ["dice"], probability: 0 } }),
      makeEntry("p100", "always", { activation: { primaryKeys: ["dice"], probability: 100 } }),
    ]),
    corpus,
  });
  assert.deepEqual(activatedIds(result), ["p100"]);
  assert.equal(omittedFor(result, "p0").reason, "probability");
  // A 0% entry consumes no PRNG draw; a 100% entry needs none either.
  assert.equal(result.complexity.probabilityDraws, 0);
});

check("mid-range probability is deterministic per seed and varies by turnId", () => {
  const corpus = makeCorpus({ messages: [msg(1, "dice on the table")] });
  const book = makeBook([makeEntry("p50", "maybe", {
    activation: { primaryKeys: ["dice"], probability: 50 },
  })]);
  const outcomes = new Map();
  for (let turn = 1; turn <= 40; turn += 1) {
    const input = resolveInput({
      bookRevision: book,
      corpus,
      seedIdentity: { ownerScope: "profile:local", sessionId: "session-1", turnId: `turn-${turn}` },
    });
    const first = resolveWorldBookActivation(input);
    const second = resolveWorldBookActivation(input);
    assert.deepEqual(second, first);
    outcomes.set(turn, activatedIds(first).length);
  }
  const distinct = new Set(outcomes.values());
  assert.deepEqual([...distinct].sort(), [0, 1]);
});

// ------------------------------------------------------- inclusion groups ---

check("entries sharing an inclusion group resolve to exactly one winner", () => {
  const corpus = makeCorpus({ messages: [msg(1, "alpha beta")] });
  const result = run({
    bookRevision: makeBook([
      makeEntry("ga", "A", { activation: { primaryKeys: ["alpha"], inclusionGroups: ["g"] } }),
      makeEntry("gb", "B", { activation: { primaryKeys: ["beta"], inclusionGroups: ["g"] } }),
      makeEntry("gc", "C", { activation: { primaryKeys: ["alpha"] } }),
    ]),
    corpus,
  });
  const ids = activatedIds(result);
  assert.equal(ids.includes("gc"), true);
  assert.equal(ids.filter((id) => id === "ga" || id === "gb").length, 1);
  const loser = ids.includes("ga") ? "gb" : "ga";
  assert.equal(omittedFor(result, loser).reason, "group_conflict");
});

check("prioritized inclusion picks the highest insertion order deterministically", () => {
  const corpus = makeCorpus({ messages: [msg(1, "alpha beta")] });
  const book = makeBook([
    makeEntry("pa", "A", {
      activation: { primaryKeys: ["alpha"], inclusionGroups: ["g"], prioritizeInclusion: true },
      insertion: { order: 10 },
    }),
    makeEntry("pb", "B", {
      activation: { primaryKeys: ["beta"], inclusionGroups: ["g"], prioritizeInclusion: true },
      insertion: { order: 60 },
    }),
  ]);
  for (let turn = 1; turn <= 5; turn += 1) {
    const result = run({
      bookRevision: book,
      corpus,
      seedIdentity: { ownerScope: "o", sessionId: "s", turnId: `t-${turn}` },
    });
    assert.deepEqual(activatedIds(result).sort(), ["pb"]);
    assert.equal(omittedFor(result, "pa").reason, "group_conflict");
  }
});

check("weighted group choice is rejection-sampled and replayable across seeds", () => {
  const corpus = makeCorpus({ messages: [msg(1, "alpha beta gamma")] });
  const book = makeBook([
    makeEntry("w1", "1", { activation: { primaryKeys: ["alpha"], inclusionGroups: ["g"], groupWeight: 10 } }),
    makeEntry("w2", "2", { activation: { primaryKeys: ["beta"], inclusionGroups: ["g"], groupWeight: 20 } }),
    makeEntry("w3", "3", { activation: { primaryKeys: ["gamma"], inclusionGroups: ["g"], groupWeight: 70 } }),
  ]);
  const winners = new Map();
  for (let turn = 1; turn <= 60; turn += 1) {
    const input = resolveInput({
      bookRevision: book,
      corpus,
      seedIdentity: { ownerScope: "o", sessionId: "s", turnId: `t-${turn}` },
    });
    const first = resolveWorldBookActivation(input);
    assert.deepEqual(resolveWorldBookActivation(input), first);
    winners.set(turn, activatedIds(first)[0]);
  }
  // Distribution shape is proven deterministic, not statistical: the exact
  // winner sequence is a pure function of the seeds, and every entry can win.
  const replay = new Map();
  for (let turn = 1; turn <= 60; turn += 1) {
    replay.set(turn, activatedIds(run({
      bookRevision: book,
      corpus,
      seedIdentity: { ownerScope: "o", sessionId: "s", turnId: `t-${turn}` },
    }))[0]);
  }
  assert.deepEqual([...replay.values()], [...winners.values()]);
  assert.deepEqual([...new Set(winners.values())].sort(), ["w1", "w2", "w3"]);
});

check("group scoring keeps only the highest key-match score in the group", () => {
  const corpus = makeCorpus({ messages: [msg(1, "red blue green")] });
  const result = run({
    bookRevision: makeBook([
      makeEntry("sa", "A", {
        activation: {
          primaryKeys: ["red", "blue"], inclusionGroups: ["g"], useGroupScoring: true,
        },
      }),
      makeEntry("sb", "B", {
        activation: { primaryKeys: ["green"], inclusionGroups: ["g"], useGroupScoring: true },
      }),
    ]),
    corpus,
  });
  assert.deepEqual(activatedIds(result), ["sa"]);
  assert.equal(result.activated[0].matchedKeyCount, 2);
  assert.equal(omittedFor(result, "sb").reason, "group_conflict");
});

check("conflict graph resolution repeats until no conflict remains", () => {
  const corpus = makeCorpus({ messages: [msg(1, "one two three")] });
  const result = run({
    bookRevision: makeBook([
      makeEntry("ta", "A", {
        activation: {
          primaryKeys: ["one"], inclusionGroups: ["g1"], prioritizeInclusion: true,
        },
        insertion: { order: 100 },
      }),
      makeEntry("tb", "B", {
        activation: { primaryKeys: ["two"], inclusionGroups: ["g1", "g2"] },
      }),
      makeEntry("tc", "C", {
        activation: { primaryKeys: ["three"], inclusionGroups: ["g2"] },
      }),
    ]),
    corpus,
  });
  // ta wins the first round (prioritized), eliminating tb; tc no longer
  // conflicts with anything, so it survives.
  assert.deepEqual(activatedIds(result).sort(), ["ta", "tc"]);
  assert.equal(omittedFor(result, "tb").reason, "group_conflict");
});

// -------------------------------------------------------------- recursion ---

function recursionBook(policy = {}) {
  return makeBook([
    makeEntry("ra", "all about beta creatures", { activation: { primaryKeys: ["alpha"] } }),
    makeEntry("rb", "the gamma ritual", { activation: { primaryKeys: ["beta"] } }),
    makeEntry("rc", "omega", { activation: { primaryKeys: ["gamma"] } }),
  ], { recursive: true, maxRecursionSteps: 4, ...policy });
}

check("activated content triggers further entries as a bounded fixed point", () => {
  const result = run({
    bookRevision: recursionBook(),
    corpus: makeCorpus({ messages: [msg(1, "tell me of alpha")] }),
  });
  assert.deepEqual(activatedIds(result).sort(), ["ra", "rb", "rc"]);
  const levels = Object.fromEntries(result.activated.map((entry) => [entry.entryId, entry.recursionLevel]));
  assert.deepEqual(levels, { ra: 0, rb: 1, rc: 2 });
  assert.equal(result.activated.find((entry) => entry.entryId === "rb").sourceScope, "recursion");
  assert.equal(result.complexity.recursionFrontiers, 2);
});

check("preventFurtherRecursion stops propagation from an entry's content", () => {
  const book = makeBook([
    makeEntry("ra", "all about beta creatures", { activation: { primaryKeys: ["alpha"] } }),
    makeEntry("rb", "the gamma ritual", {
      activation: { primaryKeys: ["beta"] },
      recursion: { preventFurtherRecursion: true },
    }),
    makeEntry("rc", "omega", { activation: { primaryKeys: ["gamma"] } }),
  ], { recursive: true, maxRecursionSteps: 4 });
  const result = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(1, "alpha")] }),
  });
  assert.deepEqual(activatedIds(result).sort(), ["ra", "rb"]);
});

check("excludeFromRecursion entries never match from the recursion corpus", () => {
  const book = makeBook([
    makeEntry("ra", "all about beta creatures", { activation: { primaryKeys: ["alpha"] } }),
    makeEntry("rd", "blocked", {
      activation: { primaryKeys: ["beta"] },
      recursion: { excludeFromRecursion: true },
    }),
  ], { recursive: true, maxRecursionSteps: 4 });
  const fromChat = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(1, "alpha")] }),
  });
  assert.deepEqual(activatedIds(fromChat), ["ra"]);
  // The same entry still matches from the real chat corpus.
  const direct = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(1, "beta")] }),
  });
  assert.deepEqual(activatedIds(direct).sort(), ["rd"]);
});

check("delayUntilRecursion entries are admitted only at their declared level", () => {
  const book = makeBook([
    makeEntry("ra", "all about beta creatures", { activation: { primaryKeys: ["alpha"] } }),
    makeEntry("rl1", "level one", {
      activation: { primaryKeys: ["beta"] },
      recursion: { delayUntilRecursion: true, recursionLevel: 1 },
    }),
    makeEntry("rl2", "level two", {
      activation: { primaryKeys: ["gamma"], inclusionGroups: [] },
      recursion: { delayUntilRecursion: true, recursionLevel: 2 },
    }),
    makeEntry("rb", "the gamma ritual", { activation: { primaryKeys: ["beta"] } }),
  ], { recursive: true, maxRecursionSteps: 4 });
  const result = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(1, "alpha")] }),
  });
  const levels = Object.fromEntries(result.activated.map((entry) => [entry.entryId, entry.recursionLevel]));
  assert.equal(levels.rl1, 1);
  assert.equal(levels.rl2, 2);
  // rl1's key "beta" is present in the initial chat corpus ("alpha" message
  // does not contain beta) — it may only fire at level 1, never level 0.
  const direct = run({
    bookRevision: makeBook([makeEntry("rl0", "x", {
      activation: { primaryKeys: ["beta"] },
      recursion: { delayUntilRecursion: true, recursionLevel: 1 },
    })], { recursive: true, maxRecursionSteps: 4 }),
    corpus: makeCorpus({ messages: [msg(1, "beta")] }),
  });
  assert.deepEqual(activatedIds(direct), []);
});

check("selection never reactivates an already selected entry", () => {
  const book = makeBook([
    makeEntry("self", "alpha and alpha again", { activation: { primaryKeys: ["alpha"] } }),
  ], { recursive: true, maxRecursionSteps: 4 });
  const result = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(1, "alpha")] }),
  });
  assert.deepEqual(activatedIds(result), ["self"]);
});

check("recursion stops at maxRecursionSteps", () => {
  const result = run({
    bookRevision: recursionBook({ maxRecursionSteps: 1 }),
    corpus: makeCorpus({ messages: [msg(1, "alpha")] }),
  });
  assert.deepEqual(activatedIds(result).sort(), ["ra", "rb"]);
  assert.equal(result.complexity.recursionFrontiers, 1);
});

// ------------------------------------------------------- timed effects ------

check("sticky carry-over activates without key match until exhausted", () => {
  const book = makeBook([makeEntry("st", "tide lore", {
    activation: { primaryKeys: ["zephyr"], stickyMessages: 2 },
  })]);
  const turn1 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(10, "a zephyr rises")] }),
  });
  assert.deepEqual(activatedIds(turn1), ["st"]);
  assert.deepEqual(turn1.nextCheckpoint.sticky, [{ entryId: "st", untilSeq: 12 }]);

  const turn2 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(11, "calm waters")] }),
    checkpoint: turn1.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn2), ["st"]);
  assert.equal(turn2.activated[0].reason, "sticky");
  assert.equal(turn2.activated[0].matchedKeyCount, 0);
  // Sticky carry-over skips repeat probability under the v1 profile.
  assert.equal(turn2.complexity.probabilityDraws, 0);
  // Running effects are never refreshed by consequent matches.
  assert.deepEqual(turn2.nextCheckpoint.sticky, [{ entryId: "st", untilSeq: 12 }]);

  const turn3 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(12, "still calm")] }),
    checkpoint: turn2.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn3), ["st"]);

  const turn4 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(13, "gone")] }),
    checkpoint: turn3.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn4), []);
  assert.deepEqual(turn4.nextCheckpoint.sticky, []);
});

check("sticky carry-over skips repeat probability under the v1 profile", () => {
  // A 0%-probability entry could never activate on a fresh roll; the carried
  // sticky effect activates it without re-rolling (profile requirement).
  const book = makeBook([makeEntry("sp", "tide lore", {
    activation: { primaryKeys: ["zephyr"], stickyMessages: 4, probability: 0 },
  })]);
  const result = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(11, "calm waters")] }),
    checkpoint: { sticky: [{ entryId: "sp", untilSeq: 12 }], cooldown: [], delay: [] },
  });
  assert.deepEqual(activatedIds(result), ["sp"]);
  assert.equal(result.activated[0].reason, "sticky");
  assert.equal(result.complexity.probabilityDraws, 0);
  // No refresh: the running effect keeps its original boundary.
  assert.deepEqual(result.nextCheckpoint.sticky, [{ entryId: "sp", untilSeq: 12 }]);
});

check("cooldown blocks reactivation by canonical sequence numbers", () => {
  const book = makeBook([makeEntry("cd", "bell tolls", {
    activation: { constant: true, cooldownMessages: 2 },
  })]);
  const turn1 = run({ bookRevision: book, corpus: makeCorpus({ messages: [msg(10, "x")] }) });
  assert.deepEqual(activatedIds(turn1), ["cd"]);
  assert.deepEqual(turn1.nextCheckpoint.cooldown, [{ entryId: "cd", untilSeq: 12 }]);

  const turn2 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(11, "x")] }),
    checkpoint: turn1.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn2), []);
  assert.equal(omittedFor(turn2, "cd").reason, "cooldown_active");
  assert.deepEqual(turn2.nextCheckpoint.cooldown, [{ entryId: "cd", untilSeq: 12 }]);

  const turn3 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(12, "x")] }),
    checkpoint: turn2.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn3), []);

  const turn4 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(13, "x")] }),
    checkpoint: turn3.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn4), ["cd"]);
});

check("delay defers a match until its message distance is reached", () => {
  const book = makeBook([makeEntry("dl", "ember lore", {
    activation: { primaryKeys: ["ember"], delayMessages: 2 },
  })]);
  const turn1 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(10, "an ember glows")] }),
  });
  assert.deepEqual(activatedIds(turn1), []);
  assert.equal(omittedFor(turn1, "dl").reason, "delay_pending");
  assert.deepEqual(turn1.nextCheckpoint.delay, [{ entryId: "dl", matchedSeq: 10 }]);

  // Consequent matches do not refresh the pending delay.
  const turn2 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(11, "ember again")] }),
    checkpoint: turn1.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn2), []);
  assert.deepEqual(turn2.nextCheckpoint.delay, [{ entryId: "dl", matchedSeq: 10 }]);

  // Once due, the delayed match activates even without a fresh key match.
  const turn3 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(12, "ashes")] }),
    checkpoint: turn2.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn3), ["dl"]);
  assert.equal(turn3.activated[0].reason, "delay_due");
  assert.deepEqual(turn3.nextCheckpoint.delay, []);
});

// ----------------------------------------------------------------- filters --

check("character and generation filters run before probability", () => {
  const corpus = makeCorpus({ messages: [msg(1, "dice")] });
  const book = makeBook([
    makeEntry("cf", "x", {
      activation: {
        primaryKeys: ["dice"], probability: 50,
        characterFilter: { mode: "exclude", characterNames: ["Luna"] },
      },
    }),
    makeEntry("gf", "x", {
      activation: { primaryKeys: ["dice"], probability: 50, generationTriggers: ["summary"] },
    }),
  ]);
  const result = run({ bookRevision: book, corpus });
  assert.deepEqual(activatedIds(result), []);
  assert.equal(omittedFor(result, "cf").reason, "character_filter");
  assert.equal(omittedFor(result, "gf").reason, "generation_filter");
  // Filters run before probability: no draws were consumed.
  assert.equal(result.complexity.probabilityDraws, 0);

  const included = run({
    bookRevision: makeBook([
      makeEntry("cf", "x", {
        activation: { characterFilter: { mode: "include", characterNames: ["Luna"] }, constant: true },
      }),
      makeEntry("gf", "x", {
        activation: { constant: true, generationTriggers: ["summary"] },
      }),
    ]),
    corpus,
    generationContext: { characterName: "Luna", characterTags: [], kind: "summary" },
  });
  assert.deepEqual(activatedIds(included).sort(), ["cf", "gf"]);
});

// ------------------------------------------------------------------ budget --

check("entry budget truncation records omissions with reasons", () => {
  const book = makeBook([
    makeEntry("b1", "one", { activation: { constant: true }, insertion: { order: 10 } }),
    makeEntry("b2", "two", { activation: { constant: true }, insertion: { order: 20 } }),
    makeEntry("b3", "three", { activation: { constant: true }, insertion: { order: 30 } }),
  ]);
  const result = run({ bookRevision: book, budget: { maxEntries: 2 } });
  // Larger insertion-order values win budget priority by default.
  assert.deepEqual(activatedIds(result), ["b2", "b3"]);
  assert.equal(omittedFor(result, "b1").reason, "budget_entries");
});

check("explicit priority outranks insertion order in budget selection", () => {
  const book = makeBook([
    makeEntry("low", "one", { activation: { constant: true }, insertion: { order: 90 } }),
    makeEntry("high", "two", { activation: { constant: true }, insertion: { order: 10, priority: 5 } }),
  ]);
  const result = run({ bookRevision: book, budget: { maxEntries: 1 } });
  assert.deepEqual(activatedIds(result), ["high"]);
  assert.equal(omittedFor(result, "low").reason, "budget_entries");
});

check("token budget truncation records omissions with reasons", () => {
  const book = makeBook([
    makeEntry("t1", "a".repeat(10), { activation: { constant: true }, insertion: { order: 20 } }),
    makeEntry("t2", "b".repeat(10), { activation: { constant: true }, insertion: { order: 10 } }),
  ]);
  const result = run({ bookRevision: book, budget: { maxTokens: 15 } });
  assert.deepEqual(activatedIds(result), ["t1"]);
  assert.equal(omittedFor(result, "t2").reason, "budget_tokens");
});

// -------------------------------------------------------- inert / fallback --

check("useRegex entries activate nothing and are reported inert (fail closed)", () => {
  const result = run({
    bookRevision: makeBook([makeEntry("rx", "regex lore", {
      activation: { primaryKeys: ["lorem"], useRegex: true },
    })]),
    corpus: makeCorpus({ messages: [msg(1, "lorem ipsum")] }),
  });
  assert.deepEqual(activatedIds(result), []);
  assert.deepEqual(result.trace.inert.regex, ["rx"]);
  assert.equal(omittedFor(result, "rx").reason, "regex_inert");
});

check("vectorized entries fall back to deterministic lexical-only behavior", () => {
  const withKeys = run({
    bookRevision: makeBook([makeEntry("vec", "vector lore", {
      activation: { primaryKeys: ["lorem"], vectorized: true },
    })]),
    corpus: makeCorpus({ messages: [msg(1, "lorem ipsum")] }),
  });
  assert.deepEqual(activatedIds(withKeys), ["vec"]);
  assert.deepEqual(withKeys.trace.inert.vectorized, ["vec"]);

  const withoutKeys = run({
    bookRevision: makeBook([makeEntry("vec2", "vector only", {
      activation: { vectorized: true },
    })]),
    corpus: makeCorpus({ messages: [msg(1, "lorem ipsum")] }),
  });
  assert.deepEqual(activatedIds(withoutKeys), []);
  assert.equal(omittedFor(withoutKeys, "vec2").reason, "vectorized_semantic_unavailable");
});

// --------------------------------------------------------- min activations --

check("min-activation sweeps progressively scan older canonical messages", () => {
  const book = makeBook([
    makeEntry("c1", "constant lore", { activation: { constant: true } }),
    makeEntry("old", "ancient lore", { activation: { primaryKeys: ["ancient"] } }),
    makeEntry("chain", "chained", { activation: { primaryKeys: ["lore"] } }),
  ], {
    scanDepthMessages: 1, minActivations: 2, maxDepthMessages: 4, recursive: true,
  });
  const corpus = makeCorpus({
    messages: [msg(1, "ancient ruins"), msg(2, "mid"), msg(3, "mid"), msg(4, "now")],
    scanPolicy: { scanDepthMessages: 1, minActivations: 2, maxDepthMessages: 4 },
  });
  const result = run({ bookRevision: book, corpus });
  assert.deepEqual(activatedIds(result).sort(), ["c1", "old"]);
  assert.equal(result.complexity.sweeps, 3);
  // minActivations and recursion are mutually exclusive policies: the
  // activated "ancient lore" content must NOT trigger the "lore" key.
  assert.equal(activatedIds(result).includes("chain"), false);
});

// ------------------------------------------------------------- determinism --

check("identical inputs resolve byte-for-byte identically across processes", () => {
  const book = makeBook([
    makeEntry("det-a", "A".repeat(40), {
      activation: { primaryKeys: ["harbor"], secondaryKeys: ["storm"], selective: true },
    }),
    makeEntry("det-b", "B".repeat(30), {
      activation: { primaryKeys: ["harbor"], probability: 50, inclusionGroups: ["g"], groupWeight: 30 },
    }),
    makeEntry("det-c", "C".repeat(20), {
      activation: { primaryKeys: ["storm"], probability: 70, inclusionGroups: ["g"], groupWeight: 70 },
    }),
    makeEntry("det-d", "D".repeat(10), { activation: { constant: true, stickyMessages: 2 } }),
  ]);
  const corpus = makeCorpus({ messages: [msg(9, "the harbor storm"), msg(10, "calm")] });
  const checkpoint = { sticky: [{ entryId: "det-d", untilSeq: 11 }], cooldown: [], delay: [] };
  const input = resolveInput({ bookRevision: book, corpus, checkpoint });
  const local = resolveWorldBookActivation(input);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-activation-"));
  const inputPath = path.join(tmp, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(input));
  try {
    const childCode = `
      const fs = require("node:fs");
      const path = require("node:path");
      const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const root = process.argv[2];
      const { resolveWorldBookActivation } = require(path.join(root, "src/main/character-worlds/world-book-activation.js"));
      const { stableJson } = require(path.join(root, "src/main/character-worlds/persistence-codec.js"));
      process.stdout.write(stableJson(resolveWorldBookActivation(input)));
    `;
    const childOutput = execFileSync(
      process.execPath, ["-e", childCode, inputPath, ROOT], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const { stableJson: codecStableJson } = require("../src/main/character-worlds/persistence-codec.js");
    assert.equal(childOutput, codecStableJson(local));
    assert.equal(childOutput, codecStableJson(resolveWorldBookActivation(input)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check("trace records policy version, winners, and eliminations without private text", () => {
  const result = run({
    bookRevision: makeBook([
      makeEntry("tr-a", "A", { activation: { primaryKeys: ["harbor"], inclusionGroups: ["g"] } }),
      makeEntry("tr-b", "B", { activation: { primaryKeys: ["storm"], inclusionGroups: ["g"] } }),
    ]),
    corpus: makeCorpus({ messages: [msg(1, "xyzzy-private harbor storm")] }),
  });
  assert.equal(result.trace.matchingPolicyVersion, WORLD_BOOK_MATCHING_POLICY_VERSION);
  assert.equal(result.trace.unicodeVersion, process.versions.unicode);
  assert.match(result.trace.revisionHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.trace.seedIdentity, {
    ownerScope: "profile:local", sessionId: "session-1", turnId: "turn-1",
  });
  assert.equal(result.trace.groups.length, 1);
  const group = result.trace.groups[0];
  assert.deepEqual([...group.component].sort(), ["tr-a", "tr-b"]);
  assert.ok(result.activated.some((entry) => entry.entryId === group.winnerId));
  assert.deepEqual(group.eliminated, [group.component.find((id) => id !== group.winnerId)]);
  const serialized = JSON.stringify(result.trace);
  assert.ok(!serialized.includes("xyzzy-private"));
  assert.ok(!serialized.includes("harbor storm"));
});

check("activation work is bounded by deterministic operation counters", () => {
  assert.throws(
    () => run({
      bookRevision: makeBook([makeEntry("x", "y", { activation: { constant: true } })]),
      budget: { maxOperations: 1 },
    }),
    (error) => error.code === "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED",
  );
});

// -------------------------------------------------------------- adversarial -

check("an adversarial 10k-entry book stays within counters and time", () => {
  const entries = [];
  for (let index = 0; index < 10_000; index += 1) {
    const keys = [`needle-${index}`];
    if (index < 500) keys.push("shared-key");
    entries.push(makeEntry(`adv-${index}`, `lore ${index}`, {
      activation: { primaryKeys: keys },
    }));
  }
  const book = makeBook(entries, { scanDepthMessages: 4 });
  const messages = [];
  for (let seq = 1; seq <= 20; seq += 1) {
    messages.push(msg(seq, `filler ${seq} ${seq === 20 ? "shared-key" : ""}`));
  }
  const corpus = makeCorpus({ messages, scanPolicy: { scanDepthMessages: 4 } });
  const startedAt = Date.now();
  const result = run({ bookRevision: book, corpus });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.activated.length, 256);
  assert.equal(result.activated[0].entryId, "adv-0");
  assert.ok(result.omitted.length <= DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxOmitted);
  assert.ok(result.complexity.operations <= DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxOperations);
  assert.ok(result.complexity.automatonStates > 0);
  assert.ok(elapsedMs < 10_000, `10k-entry resolve took ${elapsedMs}ms`);
  // Deterministic replay of the adversarial book.
  assert.deepEqual(run({ bookRevision: book, corpus }), result);
});

// ------------------------------------------------- review hardening --------

check("a 10k-entry single inclusion group resolves in one round, near-linear", () => {
  const entries = [];
  for (let index = 0; index < 10_000; index += 1) {
    entries.push(makeEntry(`g10k-${index}`, `lore ${index}`, {
      activation: { constant: true, inclusionGroups: ["mega"] },
    }));
  }
  const book = makeBook(entries);
  const corpus = makeCorpus({ messages: [] });
  const startedAt = Date.now();
  const result = run({ bookRevision: book, corpus });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.activated.length, 1);
  assert.equal(result.complexity.groupRounds, 1);
  assert.ok(result.complexity.operations <= DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxOperations);
  assert.ok(elapsedMs < 1_000, `10k single-group resolve took ${elapsedMs}ms`);
  assert.deepEqual(run({ bookRevision: book, corpus }), result);
});

check("a 9000-entry path conflict graph terminates bounded and deterministic", () => {
  const entries = [];
  for (let index = 0; index < 9_000; index += 1) {
    const groups = [];
    if (index > 0) groups.push(`p${index - 1}`);
    if (index < 8_999) groups.push(`p${index}`);
    entries.push(makeEntry(`path-${index}`, `lore ${index}`, {
      activation: { constant: true, inclusionGroups: groups },
    }));
  }
  const book = makeBook(entries);
  const corpus = makeCorpus({ messages: [] });
  const startedAt = Date.now();
  const result = run({ bookRevision: book, corpus });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(result.activated.length > 0);
  assert.ok(
    result.complexity.groupRounds <= DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxGroupRounds,
    `rounds ${result.complexity.groupRounds}`,
  );
  assert.ok(result.complexity.operations <= DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxOperations);
  assert.ok(elapsedMs < 5_000, `9000-entry path resolve took ${elapsedMs}ms`);
  assert.deepEqual(run({ bookRevision: book, corpus }), result);
});

check("maxGroupRounds breach fails coded instead of hanging", () => {
  // Prioritized path: each round eliminates exactly two entries, so six
  // entries need three rounds — a 2-round cap must trip deterministically.
  const book = makeBook(
    ["a", "b", "c", "d", "e", "f"].map((id, index) => makeEntry(id, "x", {
      activation: {
        constant: true,
        prioritizeInclusion: true,
        inclusionGroups: [
          ...(index > 0 ? [`p${index - 1}`] : []),
          ...(index < 5 ? [`p${index}`] : []),
        ],
      },
      insertion: { order: index },
    })),
  );
  assert.throws(
    () => run({ bookRevision: book, corpus: makeCorpus({ messages: [] }), budget: { maxGroupRounds: 2 } }),
    (error) => error.code === "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED"
      && error.limit === "maxGroupRounds",
  );
});

check("maxCandidatesPerFrontier breach fails coded", () => {
  const book = makeBook(
    Array.from({ length: 10 }, (_, index) => makeEntry(`cand-${index}`, "x", {
      activation: { constant: true },
    })),
  );
  assert.throws(
    () => run({
      bookRevision: book,
      corpus: makeCorpus({ messages: [] }),
      budget: { maxCandidatesPerFrontier: 8 },
    }),
    (error) => error.code === "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED"
      && error.limit === "maxCandidatesPerFrontier",
  );
});

check("group weight totals above 2^32 are down-scaled, never an uncoded crash", () => {
  const entries = [];
  for (let index = 0; index < 5_000; index += 1) {
    entries.push(makeEntry(`heavy-${index}`, "x", {
      activation: { constant: true, inclusionGroups: ["heavy"], groupWeight: 1_000_000 },
    }));
  }
  const book = makeBook(entries);
  const corpus = makeCorpus({ messages: [] });
  const result = run({ bookRevision: book, corpus });
  assert.equal(result.activated.length, 1);
  assert.equal(result.complexity.groupRounds, 1);
  assert.deepEqual(run({ bookRevision: book, corpus }), result);
});

check("due delays losing a group conflict are re-pended, not vanished", () => {
  const book = makeBook([
    makeEntry("dd", "delay lore", {
      activation: { primaryKeys: ["ember"], delayMessages: 1, inclusionGroups: ["g"] },
    }),
    makeEntry("gg", "group winner", {
      activation: { primaryKeys: ["storm"], inclusionGroups: ["g"], prioritizeInclusion: true },
      insertion: { order: 50 },
    }),
  ]);
  const turn1 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(10, "an ember in the storm")] }),
  });
  assert.deepEqual(activatedIds(turn1), ["gg"]);
  assert.deepEqual(turn1.nextCheckpoint.delay, [{ entryId: "dd", matchedSeq: 10 }]);

  const turn2 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(11, "storm again")] }),
    checkpoint: turn1.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn2), ["gg"]);
  assert.equal(omittedFor(turn2, "dd").reason, "group_conflict");
  // Transient block: the due delay keeps its original matchedSeq.
  assert.deepEqual(turn2.nextCheckpoint.delay, [{ entryId: "dd", matchedSeq: 10 }]);

  const turn3 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(12, "calm")] }),
    checkpoint: turn2.nextCheckpoint,
  });
  assert.deepEqual(activatedIds(turn3), ["dd"]);
  assert.deepEqual(turn3.nextCheckpoint.delay, []);
});

check("due delays blocked by contextual filters are dropped, not re-pended", () => {
  const book = makeBook([makeEntry("df", "delay lore", {
    activation: {
      primaryKeys: ["ember"],
      delayMessages: 1,
      characterFilter: { mode: "exclude", characterNames: ["Luna"] },
    },
  })]);
  const turn1 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(10, "an ember glows")] }),
    generationContext: { characterName: "Other", characterTags: [], kind: "normal" },
  });
  assert.deepEqual(turn1.nextCheckpoint.delay, [{ entryId: "df", matchedSeq: 10 }]);

  const turn2 = run({
    bookRevision: book,
    corpus: makeCorpus({ messages: [msg(11, "still glowing ember")] }),
    checkpoint: turn1.nextCheckpoint,
    generationContext: { characterName: "Luna", characterTags: [], kind: "normal" },
  });
  assert.deepEqual(activatedIds(turn2), []);
  assert.equal(omittedFor(turn2, "df").reason, "character_filter");
  assert.deepEqual(turn2.nextCheckpoint.delay, []);
});

check("U+001F in seed identity fields or entry ids is rejected coded", () => {
  // The two colliding identities from the review now both reject instead of
  // silently sharing one PRNG stream.
  for (const seedIdentity of [
    { ownerScope: "a\u001fb", sessionId: "c", turnId: "t" },
    { ownerScope: "a", sessionId: "b\u001fc", turnId: "t" },
    { ownerScope: "a", sessionId: "s", turnId: "t\u001fu" },
  ]) {
    assert.throws(
      () => run({ seedIdentity }),
      (error) => error.code === "WORLD_BOOK_ACTIVATION_INPUT",
    );
  }
  assert.throws(
    () => run({ revisionHash: "sha256:dead\u001fbeef" }),
    (error) => error.code === "WORLD_BOOK_ACTIVATION_INPUT",
  );
  assert.throws(
    () => run({ bookRevision: makeBook([makeEntry("evil\u001fid", "x", { activation: { constant: true } })]) }),
    (error) => error.code === "WORLD_BOOK_ACTIVATION_INPUT",
  );
});

check("oversized checkpoint intake is truncated deterministically and counted", () => {
  const sticky = [];
  for (let index = 0; index < 500_000; index += 1) {
    sticky.push({ entryId: `ghost-${index}`, untilSeq: 100 });
  }
  const result = run({
    bookRevision: makeBook([makeEntry("c", "x", { activation: { constant: true } })]),
    checkpoint: { sticky, cooldown: [], delay: [] },
  });
  assert.deepEqual(activatedIds(result), ["c"]);
  assert.equal(
    result.trace.truncated.checkpoint,
    500_000 - DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxTimedEntries,
  );
  assert.ok(result.nextCheckpoint.sticky.length <= DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxTimedEntries);
});

check("minActivationsUnmet is measured after budget selection", () => {
  const book = makeBook([
    makeEntry("m1", "one", { activation: { constant: true } }),
    makeEntry("m2", "two", { activation: { constant: true } }),
  ], { scanDepthMessages: 1, minActivations: 2, maxDepthMessages: 4 });
  const corpus = makeCorpus({
    messages: [msg(1, "now")],
    scanPolicy: { scanDepthMessages: 1, minActivations: 2, maxDepthMessages: 4 },
  });
  const met = run({ bookRevision: book, corpus });
  assert.equal(met.trace.minActivationsUnmet, false);
  const capped = run({ bookRevision: book, corpus, budget: { maxEntries: 1 } });
  assert.equal(capped.activated.length, 1);
  assert.equal(capped.trace.minActivationsUnmet, true);
});

check("key-dense books trip coded index budgets before materializing", () => {
  const dense = makeBook([makeEntry("k", "x", {
    activation: { primaryKeys: ["a".repeat(200)] },
  })]);
  assert.throws(
    () => run({ bookRevision: dense, budget: { maxAutomatonStates: 64 } }),
    (error) => error.code === "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED"
      && error.limit === "maxAutomatonStates",
  );
  assert.throws(
    () => run({ bookRevision: dense, budget: { maxKeyBytes: 32 } }),
    (error) => error.code === "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED"
      && error.limit === "maxKeyBytes",
  );
});

check("trace candidates record card-declared matched key strings, bounded", () => {
  const result = run({
    bookRevision: makeBook([makeEntry("tk", "x", {
      activation: { primaryKeys: ["harbor"], secondaryKeys: ["storm"], selective: true },
    })]),
    corpus: makeCorpus({ messages: [msg(1, "the harbor storm")] }),
  });
  const record = result.trace.candidates.find((candidate) => candidate.entryId === "tk");
  assert.deepEqual(record.matchedKeys, ["harbor"]);
  assert.deepEqual(record.matchedSecondaryKeys, ["storm"]);

  const manyKeys = Array.from({ length: 20 }, (_, index) => `k${String(index).padStart(2, "0")}`);
  const wide = run({
    bookRevision: makeBook([makeEntry("wide", "x", { activation: { primaryKeys: manyKeys } })]),
    corpus: makeCorpus({ messages: [msg(1, manyKeys.join(" "))] }),
  });
  const wideRecord = wide.trace.candidates.find((candidate) => candidate.entryId === "wide");
  assert.equal(wideRecord.matchedKeys.length, 16);
  assert.equal(wideRecord.matchedKeysTruncated, 4);
  assert.equal(wideRecord.matchedKeyCount, 20);
});

check("group decisions are recorded per round", () => {
  const result = run({
    bookRevision: makeBook([
      makeEntry("ta", "A", {
        activation: { primaryKeys: ["one"], inclusionGroups: ["g1"], prioritizeInclusion: true },
        insertion: { order: 100 },
      }),
      makeEntry("tb", "B", { activation: { primaryKeys: ["two"], inclusionGroups: ["g1", "g2"] } }),
      makeEntry("tc", "C", { activation: { primaryKeys: ["three"], inclusionGroups: ["g2"] } }),
    ]),
    corpus: makeCorpus({ messages: [msg(1, "one two three")] }),
  });
  const [group] = result.trace.groups;
  assert.deepEqual(group.rounds, [{ winnerId: "ta", eliminated: ["tb"], mode: "prioritized" }]);
  assert.deepEqual(group.winners, ["ta", "tc"]);
});

console.log(`character-world-book-activation: ${checks} checks passed`);