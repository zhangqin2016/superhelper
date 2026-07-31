// Character Worlds V3 world-book decorator compilation contract
// (Phase 2, Task WB-5; spec §10.4.7).
//
// Decorator spellings are grounded in the real ecosystem:
// - Character Card V3 spec (kwaroran/character-card-spec-v3, "Decorators"):
//   @@activate, @@dont_activate, @@activate_only_after, @@is_greeting,
//   @@scan_depth, @@role, @@position, @@depth, @@reverse_depth,
//   @@keep_activate_after_match, @@dont_activate_after_match, plus @@@
//   fallback chains (top-to-bottom, chain depth at least 5, first-value rule
//   for duplicate single-value decorators, @@position > @@depth >
//   @@reverse_depth precedence).
// - SillyTavern release world-info.js: KNOWN_DECORATORS = ['@@activate',
//   '@@dont_activate'] with the same leading-line + @@@ fallback parse.
// - RisuAI lorebook.svelte.ts: same spellings for depth/reverse_depth/role/
//   scan_depth/is_greeting/activate_only_after/keep/dont_activate_after_match.
//
// Run: node scripts/test-character-world-book-decorators.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  compileWorldBookDecorators,
  WORLD_BOOK_DECORATOR_LIMITS,
} = require("../src/main/character-worlds/world-book-decorators.js");
const {
  normalizeWorldBookCanonical,
  prepareWorldBookRevision,
} = require("../src/main/character-worlds/world-book-model.js");
const { buildScanCorpus } = require("../src/main/character-worlds/world-book-corpus.js");
const {
  resolveWorldBookActivation,
} = require("../src/main/character-worlds/world-book-activation.js");
const { parseCharacterCard } = require("../src/main/character-worlds/card-parser.js");

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function jsonRound(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBook(entries, scanPolicy = {}) {
  return normalizeWorldBookCanonical({
    schemaVersion: 1,
    name: "Decorator Book",
    entries,
    scanPolicy,
  });
}

function msg(seq, text, role = "user") {
  return { seq, role, speakerName: role === "user" ? "User" : "Luna", text };
}

function resolveBook(book, overrides = {}) {
  return resolveWorldBookActivation({
    bookRevision: book,
    corpus: overrides.corpus ?? buildScanCorpus({
      messages: overrides.messages ?? [msg(1, "hello")],
      scanPolicy: book.scanPolicy,
    }),
    checkpoint: overrides.checkpoint ?? null,
    seedIdentity: { ownerScope: "profile:local", sessionId: "session-1", turnId: "turn-1" },
    compatibilityProfile: "lily-character-compat-1",
    generationContext: overrides.generationContext
      ?? { characterName: "Luna", characterTags: [], kind: "normal" },
    budget: {},
  });
}

const activatedIds = (result) => result.activated.map((entry) => entry.entryId);
const omittedFor = (result, entryId) => result.omitted.find((entry) => entry.entryId === entryId);

// ----------------------------------------------------------- compiler ----

await check("every recognized decorator parses to a typed AST and applies", () => {
  const content = [
    "@@activate",
    "@@activate_only_after 3",
    "@@is_greeting 1",
    "@@scan_depth 2",
    "@@keep_activate_after_match",
    "@@role user",
    "@@position after_desc",
    "The actual lore body.",
  ].join("\n");
  const compiled = compileWorldBookDecorators(content);
  assert.equal(compiled.content, "The actual lore body.");
  const byName = new Map(compiled.directives.map((directive) => [directive.name, directive]));
  assert.equal(byName.get("activate").kind, "flag");
  assert.equal(byName.get("activate").applied, true);
  assert.equal(byName.get("activate_only_after").kind, "int");
  assert.equal(byName.get("activate_only_after").value, 3);
  assert.equal(byName.get("is_greeting").value, 1);
  assert.equal(byName.get("scan_depth").value, 2);
  assert.equal(byName.get("keep_activate_after_match").kind, "flag");
  assert.equal(byName.get("role").kind, "enum");
  assert.equal(byName.get("role").value, "user");
  assert.equal(byName.get("position").kind, "position");
  assert.equal(byName.get("position").value, "after_character");
  assert.deepEqual(compiled.applied, {
    activation: {
      forceState: "activate",
      activateOnlyAfter: 3,
      greetingIndex: 1,
      scanDepthMessages: 2,
      statefulMatch: "keep",
    },
    insertion: { role: "user", position: "after_character" },
  });
  assert.deepEqual(compiled.inert, []);
  assert.ok(compiled.reports.every((item) => item.status === "applied"));
});

await check("depth and reverse-depth compile with typed values", () => {
  const compiled = compileWorldBookDecorators("@@depth 6\nBody.");
  assert.deepEqual(compiled.applied.insertion, {
    position: "at_depth",
    depth: 6,
    reverseDepth: false,
  });
  const reversed = compileWorldBookDecorators("@@reverse_depth 2\nBody.");
  assert.deepEqual(reversed.applied.insertion, {
    position: "at_depth",
    depth: 2,
    reverseDepth: true,
  });
});

await check("value type and range are validated before a decorator applies", () => {
  for (const bad of ["@@depth -1", "@@depth abc", "@@depth 4.5", "@@depth 10001", "@@depth"]) {
    const compiled = compileWorldBookDecorators(`${bad}\n@@scan_depth 2\nBody.`);
    assert.equal(compiled.applied.insertion.depth, undefined, `${bad} must not apply`);
    assert.equal(compiled.directives[0].applied, false);
    assert.equal(compiled.directives[0].reason, "invalid_value");
    // A valid sibling decorator still applies.
    assert.equal(compiled.applied.activation.scanDepthMessages, 2);
    // The invalid line stays in the insertable content, inert.
    assert.ok(compiled.content.startsWith(bad));
    assert.ok(compiled.content.endsWith("Body."));
    assert.deepEqual(compiled.inert.map((item) => item.reason), ["invalid_value"]);
  }
  for (const bad of ["@@activate now", "@@role narrator", "@@position nowhere", "@@scan_depth 1.5"]) {
    const compiled = compileWorldBookDecorators(`${bad}\nBody.`);
    assert.equal(compiled.directives[0].applied, false, `${bad} must not apply`);
    assert.equal(compiled.content, `${bad}\nBody.`);
  }
});

await check("duplicate single-value decorators use the first-value rule", () => {
  const compiled = compileWorldBookDecorators("@@depth 2\n@@depth 7\nBody.");
  assert.equal(compiled.applied.insertion.depth, 2);
  assert.equal(compiled.directives[0].applied, true);
  assert.equal(compiled.directives[1].applied, false);
  assert.equal(compiled.directives[1].reason, "duplicate_name");
  // Both are recognized decorator lines: stripped from the content.
  assert.equal(compiled.content, "Body.");
  assert.deepEqual(compiled.inert, []);
  assert.equal(compiled.reports[1].status, "inert");
  assert.equal(compiled.reports[1].reason, "duplicate_name");
});

await check("@@@ fallback chains evaluate top-to-bottom past depth five", () => {
  const content = [
    "@@vendor_only_a 4",
    "@@@vendor_only_b 4",
    "@@@vendor_only_c 4",
    "@@@vendor_only_d 4",
    "@@@vendor_only_e 4",
    "@@@depth 6",
    "Body.",
  ].join("\n");
  const compiled = compileWorldBookDecorators(content);
  // Six chain items, all parsed as decorator lines.
  assert.equal(compiled.directives.length, 6);
  assert.equal(compiled.directives[5].name, "depth");
  assert.equal(compiled.directives[5].applied, true);
  assert.equal(compiled.applied.insertion.depth, 6);
  // The whole chain is decorator syntax: nothing leaks into the content.
  assert.equal(compiled.content, "Body.");
  // Unknown primaries/fallbacks above the winner lost the fallback
  // evaluation: they are stripped (never preserved) and reported superseded.
  assert.deepEqual(
    compiled.directives.slice(0, 5).map((directive) => directive.reason),
    Array(5).fill("fallback_superseded"),
  );
  // A recognized fallback after the winner is superseded, never applied.
  const superseded = compileWorldBookDecorators("@@depth 6\n@@@scan_depth 9\nBody.");
  assert.equal(superseded.applied.activation.scanDepthMessages, undefined);
  assert.equal(superseded.directives[1].reason, "fallback_superseded");
  assert.equal(superseded.content, "Body.");
});

await check("chains beyond the supported depth stop evaluating", () => {
  const items = Array.from({ length: 8 }, (_, index) => `@@${index === 0 ? "" : "@"}vendor_${index} 1`);
  // 9-item chain: only the first 8 are evaluated; a valid 9th cannot apply.
  const chainLines = [...items, "@@@depth 3"];
  const compiled = compileWorldBookDecorators([...chainLines, "Body."].join("\n"));
  assert.ok(WORLD_BOOK_DECORATOR_LIMITS.maxChainDepth >= 5);
  assert.equal(compiled.directives.length, 9);
  assert.equal(compiled.directives[8].reason, "chain_depth_exceeded");
  assert.equal(compiled.applied.insertion.depth, undefined);
  // Nothing applied, so the chain stays in the content verbatim.
  assert.equal(compiled.content, `${chainLines.join("\n")}\nBody.`);
});

await check("stripping is by line index: identical inert lines survive", () => {
  // Winning chain strips its `@@@depth 3`; the separate chain-depth-exceeded
  // chain's textually identical `@@@depth 3` must REMAIN in the content.
  const winningChain = ["@@vendor_a 1", "@@@depth 3"];
  const stuckChain = [
    "@@b0", "@@@b1", "@@@b2", "@@@b3", "@@@b4", "@@@b5", "@@@b6", "@@@b7",
    "@@@depth 3",
  ];
  const compiled = compileWorldBookDecorators([...winningChain, ...stuckChain, "Body."].join("\n"));
  // The winning chain applied depth 3 and stripped both of its lines.
  assert.equal(compiled.applied.insertion.depth, 3);
  // The stuck chain never applied: all nine lines stay, including the
  // `@@@depth 3` that is textually identical to the stripped one.
  assert.equal(compiled.content, `${stuckChain.join("\n")}\nBody.`);
  assert.deepEqual(compiled.inert.map((item) => item.line), stuckChain);
  assert.equal(compiled.directives.at(-1).reason, "chain_depth_exceeded");
  // Through the model: every preserved decorator line is present in content.
  const book = makeBook([{
    id: "e1",
    content: [...winningChain, ...stuckChain, "Body."].join("\n"),
  }]);
  const [entry] = book.entries;
  assert.deepEqual(entry.preservedDecorators, stuckChain);
  for (const line of entry.preservedDecorators) {
    assert.ok(entry.content.includes(line), `missing preserved line ${line}`);
  }
});

await check("overlong decorator names are never recognized", () => {
  const name = `scan_depth${"x".repeat(100)}`;
  const compiled = compileWorldBookDecorators(`@@${name} 2\nBody.`);
  assert.equal(compiled.directives[0].reason, "unknown_decorator");
  assert.equal(compiled.applied.activation.scanDepthMessages, undefined);
  assert.equal(compiled.content, `@@${name} 2\nBody.`);
});

await check("re-normalization is idempotent for oversized decorator lines", () => {
  const longLine = `@@vendor_${"y".repeat(2000)}`;
  const once = makeBook([{ id: "e1", content: `${longLine}\nBody.` }]);
  const [entry] = once.entries;
  assert.ok(entry.content.includes(longLine));
  assert.deepEqual(entry.preservedDecorators, [longLine]);
  const twice = normalizeWorldBookCanonical(jsonRound(once));
  assert.deepEqual(jsonRound(twice), jsonRound(once));
});

await check("explicit position overrides depth; depth maps to at_depth otherwise", () => {
  const both = compileWorldBookDecorators("@@position before_desc\n@@depth 3\nBody.");
  assert.deepEqual(both.applied.insertion, { position: "before_character" });
  assert.equal(both.directives[1].name, "depth");
  assert.equal(both.directives[1].applied, false);
  assert.equal(both.directives[1].reason, "shadowed_by_position");
  // Recognized and stripped even when shadowed.
  assert.equal(both.content, "Body.");
  const depthOnly = compileWorldBookDecorators("@@depth 3\nBody.");
  assert.equal(depthOnly.applied.insertion.position, "at_depth");
  assert.equal(depthOnly.applied.insertion.depth, 3);
});

await check("reverse-depth precedence: position and depth shadow it", () => {
  const withPosition = compileWorldBookDecorators("@@position after_desc\n@@reverse_depth 2\nBody.");
  assert.deepEqual(withPosition.applied.insertion, { position: "after_character" });
  assert.equal(withPosition.directives[1].reason, "shadowed_by_position");
  const withDepth = compileWorldBookDecorators("@@depth 3\n@@reverse_depth 2\nBody.");
  assert.deepEqual(withDepth.applied.insertion, {
    position: "at_depth",
    depth: 3,
    reverseDepth: false,
  });
  assert.equal(withDepth.directives[1].reason, "shadowed_by_depth");
});

await check("unknown decorators stay in the content inert and are reported", () => {
  const content = "@@is_sensitive\n@@min_activations 2\n@@depth 2\nBody.";
  const compiled = compileWorldBookDecorators(content);
  assert.equal(compiled.content, "@@is_sensitive\n@@min_activations 2\nBody.");
  assert.deepEqual(
    compiled.inert,
    [
      { line: "@@is_sensitive", reason: "unknown_decorator" },
      { line: "@@min_activations 2", reason: "unknown_decorator" },
    ],
  );
  assert.deepEqual(
    compiled.reports.map((item) => [item.status, item.reason]),
    [
      ["inert", "unknown_decorator"],
      ["inert", "unknown_decorator"],
      ["applied", null],
    ],
  );
  // The recognized decorator between unknown ones still applies.
  assert.equal(compiled.applied.insertion.depth, 2);
});

await check("decorator text is never treated as a macro or script", () => {
  // A macro spelling inside a decorator value is data, never expanded: the
  // role decorator rejects it as an invalid enum value, and the raw line is
  // preserved verbatim.
  const compiled = compileWorldBookDecorators("@@role {{char}}\n{{char}} body {{pick:a,b}}");
  assert.equal(compiled.directives[0].applied, false);
  assert.equal(compiled.directives[0].reason, "invalid_value");
  assert.equal(compiled.directives[0].raw, "@@role {{char}}");
  assert.equal(compiled.content, "@@role {{char}}\n{{char}} body {{pick:a,b}}");
  // Applied directives carry the raw decorator text literally.
  const applied = compileWorldBookDecorators("@@scan_depth 2\nBody {{char}}");
  assert.equal(applied.directives[0].raw, "@@scan_depth 2");
  // Body macros are untouched by the compiler (the safe macro engine owns them).
  assert.equal(applied.content, "Body {{char}}");
});

await check("leading decorator lines are bounded", () => {
  const lines = Array.from({ length: 70 }, (_, index) => `@@vendor_${index} 1`);
  lines[64] = "@@depth 3"; // beyond the line cap: must not be parsed
  const compiled = compileWorldBookDecorators([...lines, "Body."].join("\n"));
  assert.equal(compiled.directives.length, WORLD_BOOK_DECORATOR_LIMITS.maxDecoratorLines);
  assert.equal(compiled.applied.insertion.depth, undefined);
  assert.ok(compiled.content.includes("@@depth 3"));
});

await check("content without decorators passes through untouched", () => {
  const compiled = compileWorldBookDecorators("plain body\n@@not_leading 3");
  assert.equal(compiled.content, "plain body\n@@not_leading 3");
  assert.deepEqual(compiled.directives, []);
  assert.deepEqual(compiled.applied, { activation: {}, insertion: {} });
  assert.deepEqual(compiled.inert, []);
  assert.deepEqual(compiled.reports, []);
});

// ------------------------------------------------------------- model -----

await check("decorators compile into the normalized entry at revision build", () => {
  const book = makeBook([{
    id: "e1",
    content: "@@role user\n@@depth 5\n@@keep_activate_after_match\nLore body.",
    activation: { primaryKeys: ["lore"] },
  }]);
  const [entry] = book.entries;
  assert.equal(entry.content, "Lore body.");
  assert.equal(entry.insertion.role, "user");
  assert.equal(entry.insertion.position, "at_depth");
  assert.equal(entry.insertion.depth, 5);
  assert.equal(entry.activation.statefulMatch, "keep");
  assert.ok(Array.isArray(entry.decorators.directives));
  assert.equal(entry.decorators.directives.length, 3);
  assert.deepEqual(entry.decorators.inert, []);
  assert.deepEqual(entry.preservedDecorators, []);
});

await check("unknown and invalid decorators land in preservedDecorators", () => {
  const book = makeBook([{ id: "e1", content: "@@is_sensitive\n@@role bogus\nBody." }]);
  const [entry] = book.entries;
  assert.equal(entry.content, "@@is_sensitive\n@@role bogus\nBody.");
  assert.deepEqual(entry.preservedDecorators, ["@@is_sensitive", "@@role bogus"]);
  assert.deepEqual(entry.decorators.inert, [
    { line: "@@is_sensitive", reason: "unknown_decorator" },
    { line: "@@role bogus", reason: "invalid_value" },
  ]);
});

await check("decorator decisions change the revision hash", () => {
  const source = { kind: "imported", format: "character_card_v3", container: "json" };
  const plain = prepareWorldBookRevision(
    makeBook([{ id: "e1", content: "Body.", activation: { primaryKeys: ["k"] } }]), source, "created", [],
  );
  const decorated = prepareWorldBookRevision(
    makeBook([{ id: "e1", content: "@@depth 2\nBody.", activation: { primaryKeys: ["k"] } }]),
    source, "created", [],
  );
  assert.notEqual(plain.revisionHash, decorated.revisionHash);
  assert.notEqual(plain.canonicalHash, decorated.canonicalHash);
  const decoratedAgain = prepareWorldBookRevision(
    makeBook([{ id: "e1", content: "@@depth 2\nBody.", activation: { primaryKeys: ["k"] } }]),
    source, "created", [],
  );
  assert.equal(decorated.revisionHash, decoratedAgain.revisionHash);
});

await check("re-normalizing a compiled entry is idempotent", () => {
  const once = makeBook([{ id: "e1", content: "@@scan_depth 2\n@@vendor_x\nBody." }]);
  const twice = normalizeWorldBookCanonical(jsonRound(once));
  assert.deepEqual(jsonRound(twice), jsonRound(once));
});

await check("golden cross-version fixture is stable", () => {
  const book = makeBook([
    {
      id: "golden-1",
      content: "@@position after_desc\n@@scan_depth 3\nGolden body.",
      activation: { primaryKeys: ["golden"] },
    },
    { id: "golden-2", content: "Plain body.", activation: { constant: true } },
  ]);
  assert.deepEqual(jsonRound(book.entries[0].decorators), {
    directives: [
      {
        name: "position", kind: "position", value: "after_character",
        raw: "@@position after_desc", applied: true, reason: null,
      },
      {
        name: "scan_depth", kind: "int", value: 3,
        raw: "@@scan_depth 3", applied: true, reason: null,
      },
    ],
    inert: [],
    applied: {
      activation: { scanDepthMessages: 3 },
      insertion: { position: "after_character" },
    },
  });
  const prepared = prepareWorldBookRevision(
    book, { kind: "imported", format: "character_card_v3", container: "json" }, "created", [],
  );
  assert.equal(
    prepared.revisionHash,
    "sha256:d8b787bd8d3ef5152dcd81608ff111456ef8c63ac197f3d117c40b3ba48a26e2",
  );
});

// ----------------------------------------------------------- resolver ----

await check("@@activate forces a keyless entry; @@dont_activate suppresses", () => {
  const book = makeBook([
    { id: "forced", content: "@@activate\nNo keys needed." },
    { id: "silenced", content: "@@dont_activate\nNever fires.", activation: { constant: true } },
    { id: "both", content: "@@dont_activate\n@@activate\nActivate wins.", activation: { constant: false } },
  ]);
  const result = resolveBook(book);
  assert.ok(activatedIds(result).includes("forced"));
  assert.equal(omittedFor(result, "silenced")?.reason, "decorator_suppressed");
  // CCV3: @@dont_activate is ignored when @@activate is present.
  assert.ok(activatedIds(result).includes("both"));
});

await check("per-entry scan-depth narrows the match window", () => {
  const messages = [msg(1, "an old tale of dragons"), msg(2, "something else"), msg(3, "recent chat")];
  const wide = makeBook([{ id: "e1", content: "Dragon lore.", activation: { primaryKeys: ["dragons"] } }]);
  const narrow = makeBook([{ id: "e1", content: "@@scan_depth 1\nDragon lore.", activation: { primaryKeys: ["dragons"] } }]);
  assert.ok(activatedIds(resolveBook(wide, { messages })).includes("e1"));
  const result = resolveBook(narrow, { messages });
  assert.ok(!activatedIds(result).includes("e1"));
  // The key in the most recent message still matches under scan_depth 1.
  const hit = resolveBook(narrow, { messages: [msg(1, "x"), msg(2, "y"), msg(3, "dragons")] });
  assert.ok(activatedIds(hit).includes("e1"));
});

await check("per-entry scan-depth stays anchored to the absolute chat head in sweeps", () => {
  const messages = [
    msg(1, "an old tale of dragons"), msg(2, "b"), msg(3, "c"), msg(4, "d"), msg(5, "e"),
  ];
  const policy = { scanDepthMessages: 2, maxDepthMessages: 5, minActivations: 1 };
  // Min-activation sweeps progressively scan older messages; a per-entry
  // @@scan_depth 1 must still only see the newest canonical message.
  const narrow = makeBook([
    { id: "e1", content: "@@scan_depth 1\nDragon lore.", activation: { primaryKeys: ["dragons"] } },
  ], policy);
  const swept = resolveBook(narrow, { messages });
  assert.ok(!activatedIds(swept).includes("e1"));
  // The book-level scan depth keeps sweep semantics: without the decorator
  // the same key in the oldest message DOES activate via a sweep.
  const wide = makeBook([
    { id: "e1", content: "Dragon lore.", activation: { primaryKeys: ["dragons"] } },
  ], policy);
  assert.ok(activatedIds(resolveBook(wide, { messages })).includes("e1"));
});

await check("activation-count gates on the canonical message sequence", () => {
  const book = makeBook([
    { id: "e1", content: "@@activate_only_after 5\nLate lore.", activation: { constant: true } },
  ]);
  const early = resolveBook(book, { messages: [msg(1, "a"), msg(2, "b"), msg(3, "c")] });
  assert.equal(omittedFor(early, "e1")?.reason, "decorator_activate_only_after");
  const late = resolveBook(book, {
    messages: [msg(1, "a"), msg(2, "b"), msg(3, "c"), msg(4, "d"), msg(5, "e"), msg(6, "f")],
  });
  assert.ok(activatedIds(late).includes("e1"));
});

await check("greeting-index gates on the generation context", () => {
  const book = makeBook([
    { id: "e1", content: "@@is_greeting 1\nGreeting lore.", activation: { constant: true } },
  ]);
  const mismatch = resolveBook(book, {
    generationContext: { characterName: "Luna", characterTags: [], kind: "normal", greetingIndex: 0 },
  });
  assert.equal(omittedFor(mismatch, "e1")?.reason, "decorator_greeting_mismatch");
  const match = resolveBook(book, {
    generationContext: { characterName: "Luna", characterTags: [], kind: "normal", greetingIndex: 1 },
  });
  assert.ok(activatedIds(match).includes("e1"));
  // CCV3: when the active greeting cannot be determined the decorator is ignored.
  const unknown = resolveBook(book);
  assert.ok(activatedIds(unknown).includes("e1"));
});

await check("stateful keep re-activates after a first match without keys", () => {
  const book = makeBook([
    { id: "e1", content: "@@keep_activate_after_match\nPersistent lore.", activation: { primaryKeys: ["once"] } },
  ]);
  const turn1 = resolveBook(book, { messages: [msg(1, "once upon a time")] });
  assert.ok(activatedIds(turn1).includes("e1"));
  assert.deepEqual(turn1.nextCheckpoint.matched, [{ entryId: "e1" }]);
  const turn2 = resolveBook(book, {
    messages: [msg(1, "once upon a time"), msg(2, "no keys here")],
    checkpoint: turn1.nextCheckpoint,
  });
  assert.ok(activatedIds(turn2).includes("e1"));
  assert.equal(turn2.activated[0].reason, "stateful");
});

await check("stateful suppress blocks the entry after its first match", () => {
  const book = makeBook([
    { id: "e1", content: "@@dont_activate_after_match\nOne-shot lore.", activation: { primaryKeys: ["once"] } },
  ]);
  const turn1 = resolveBook(book, { messages: [msg(1, "once upon a time")] });
  assert.ok(activatedIds(turn1).includes("e1"));
  const turn2 = resolveBook(book, {
    messages: [msg(1, "once upon a time"), msg(2, "once again")],
    checkpoint: turn1.nextCheckpoint,
  });
  assert.equal(omittedFor(turn2, "e1")?.reason, "stateful_suppressed");
});

await check("the insertion plan carries decorator position, depth, role, reverse-depth", () => {
  const book = makeBook([
    { id: "e1", content: "@@reverse_depth 2\n@@role assistant\nDeep lore.", activation: { constant: true } },
  ]);
  const result = resolveBook(book);
  const [plan] = result.activated;
  assert.equal(plan.position, "at_depth");
  assert.equal(plan.depth, 2);
  assert.equal(plan.reverseDepth, true);
  assert.equal(plan.role, "assistant");
});

await check("the resolver trace records decorator decisions", () => {
  const book = makeBook([
    { id: "e1", content: "@@depth 2\n@@vendor_x\nBody.", activation: { constant: true } },
    { id: "e2", content: "Plain.", activation: { constant: true } },
  ]);
  const result = resolveBook(book);
  assert.deepEqual(result.trace.decorators, { applied: 1, inert: 1 });
});

// -------------------------------------------------------------- import ---

await check("import reports decorator compatibility through the report flow", () => {
  const card = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Decorator Hero",
      description: "d",
      personality: "p",
      scenario: "s",
      first_mes: "hi",
      mes_example: "",
      character_book: {
        name: "Decorated Book",
        entries: [{
          id: "entry-dec",
          keys: ["hero"],
          content: "@@depth 2\n@@is_sensitive\n@@role bogus\nHero lore.",
          enabled: true,
        }],
      },
    },
  };
  const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card), "utf8"));
  assert.ok(parsed.characterBook, "book parsed");
  const [entry] = parsed.characterBook.canonical.entries;
  assert.equal(entry.content, "@@is_sensitive\n@@role bogus\nHero lore.");
  assert.equal(entry.insertion.position, "at_depth");
  assert.equal(entry.insertion.depth, 2);
  const report = parsed.compatibility;
  const prefix = "/data/character_book/entries/0/content";
  assert.ok(report.supported.includes(`${prefix}/0`), `missing supported ${prefix}/0`);
  assert.ok(report.preservedInert.includes(`${prefix}/1`), `missing inert ${prefix}/1`);
  assert.ok(report.ignoredInvalid.includes(`${prefix}/2`), `missing invalid ${prefix}/2`);
});

await check("import classifies superseded fallback items as ignored-invalid", () => {
  const card = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Fallback Hero",
      description: "d",
      personality: "p",
      scenario: "s",
      first_mes: "hi",
      mes_example: "",
      character_book: {
        name: "Fallback Book",
        entries: [{
          id: "entry-fb",
          keys: ["hero"],
          content: "@@vendor_only_x\n@@@scan_depth 2\nHero lore.",
          enabled: true,
        }],
      },
    },
  };
  const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card), "utf8"));
  const [entry] = parsed.characterBook.canonical.entries;
  // The winning chain stripped BOTH lines; the unknown primary lost the
  // fallback evaluation, so it is ignored-invalid — never preserved-inert.
  assert.equal(entry.content, "Hero lore.");
  assert.equal(entry.activation.scanDepthMessages, 2);
  assert.deepEqual(entry.preservedDecorators, []);
  const report = parsed.compatibility;
  const prefix = "/data/character_book/entries/0/content";
  assert.ok(report.ignoredInvalid.includes(`${prefix}/0`), `missing invalid ${prefix}/0`);
  assert.ok(report.supported.includes(`${prefix}/1`), `missing supported ${prefix}/1`);
  assert.ok(!report.preservedInert.includes(`${prefix}/0`), "superseded line must not be inert");
});

console.log(`\n${checks} decorator checks passed`);
