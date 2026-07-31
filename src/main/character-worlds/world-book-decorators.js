"use strict";

/**
 * V3 world-book decorator compiler (§10.4.7) — pure and bounded.
 *
 * Leading `@@` decorator lines in an entry's content are parsed into a typed
 * AST at immutable revision-index build time; recognized, valid directives
 * are compiled into normalized entry field overrides and their lines are
 * removed from the insertable content. Unknown or invalid decorators stay in
 * the content verbatim (inert) and are reported. Decorator text is data only:
 * it is never macro-expanded, scripted, or treated as a Lily instruction.
 *
 * Recognized spellings, grounded in the ecosystem:
 * - Character Card V3 spec (kwaroran/character-card-spec-v3, "Decorators"):
 *   @@activate, @@dont_activate, @@activate_only_after, @@is_greeting,
 *   @@scan_depth, @@role, @@position (after_desc/before_desc/personality/
 *   scenario), @@depth, @@reverse_depth, @@keep_activate_after_match,
 *   @@dont_activate_after_match, and `@@@` fallback chains (top-to-bottom,
 *   chain depth at least 5, first-value rule for duplicate single-value
 *   decorators, @@position > @@depth > @@reverse_depth precedence).
 * - SillyTavern release world-info.js: KNOWN_DECORATORS = ['@@activate',
 *   '@@dont_activate'] with the same leading-line + `@@@` fallback parse.
 * - RisuAI lorebook.svelte.ts: the same spellings for depth / reverse_depth /
 *   role / scan_depth / is_greeting / activate_only_after /
 *   keep_activate_after_match / dont_activate_after_match.
 *
 *   spelling                          kind      compiles into
 *   @@activate                        flag      activation.forceState = "activate"
 *   @@dont_activate                   flag      activation.forceState = "suppress"
 *   @@activate_only_after N           int       activation.activateOnlyAfter = N
 *     (aliases: @@activate_after, @@activate_count)
 *   @@is_greeting N                   int       activation.greetingIndex = N
 *   @@scan_depth N                    int       activation.scanDepthMessages = N
 *   @@keep_activate_after_match       flag      activation.statefulMatch = "keep"
 *   @@dont_activate_after_match       flag      activation.statefulMatch = "suppress"
 *   @@role system|user|assistant      enum      insertion.role
 *   @@position <token>                position  insertion.position (CCV3
 *                                             after_desc/before_desc plus the
 *                                             SillyTavern/§7.4 spellings; CCV3
 *                                             personality/scenario have no §7.4
 *                                             bucket and are invalid)
 *   @@depth N                         int       insertion.depth = N, and
 *                                             insertion.position = "at_depth"
 *                                             when no @@position applied
 *   @@reverse_depth N                 int       as @@depth plus
 *                                             insertion.reverseDepth = true
 *
 * Ecosystem decorators Lily does not implement (@@activate_only_every,
 * @@instruct_depth, @@instruct_scan_depth, @@additional_keys, @@exclude_keys,
 * @@ignore_on_max_context, @@is_user_icon, @@disable_ui_prompt, @@end,
 * @@probability, @@priority, ...) are unknown_decorator: inert and reported.
 *
 * Pinned decisions:
 * - Duplicate rule: the first APPLIED decorator for a compile target wins;
 *   later same-target decorators are stripped and reported duplicate_name.
 *   Exception pinned by CCV3: @@activate beats @@dont_activate regardless of
 *   line order.
 * - A `@@@` line with no preceding `@@` primary starts its own chain.
 * - A chain with no recognized+valid item stays in the content whole; a
 *   chain with one is stripped whole (every line is decorator syntax), with
 *   the non-applied items reported fallback_superseded (including unknown or
 *   invalid items — they are stripped, never preserved), duplicate_name, or
 *   shadowed_by_position / shadowed_by_depth. Stripping is by consumed line
 *   INDEX, so an inert line textually identical to a stripped one survives.
 * - A decorator name longer than MAX_WORLD_BOOK_DECORATOR_NAME_CHARS (64) is
 *   never recognized; directive names/raw stored in the AST are capped at
 *   MAX_WORLD_BOOK_SHORT_STRING_CHARS so re-normalization is byte-identical.
 */

const C = require("./constants");
const { POSITION_STRINGS } = require("./character-book-fields");
const { codedError } = require("./persistence-codec");

const WORLD_BOOK_DECORATOR_LIMITS = Object.freeze({
  maxDecoratorLines: C.MAX_WORLD_BOOK_DECORATOR_LINES,
  maxChainDepth: C.MAX_WORLD_BOOK_DECORATOR_CHAIN_DEPTH,
  maxValueChars: C.MAX_WORLD_BOOK_DECORATOR_VALUE_CHARS,
});

const INVALID = Symbol("invalid");

const POSITION_VALUES = new Map([
  // CCV3 spellings first, then the SillyTavern/§7.4 position tokens.
  ["after_desc", "after_character"],
  ["before_desc", "before_character"],
  ...POSITION_STRINGS,
]);

function intValue(text, maximum) {
  if (!/^\d+$/.test(text)) return INVALID;
  const value = Number(text);
  return value <= maximum ? value : INVALID;
}

function flagValue(text) {
  return text === "" ? true : INVALID;
}

const ROLE_VALUES = new Set(["system", "user", "assistant"]);

// name -> [targetKey, kind, validate(text) -> typed value | INVALID, assign(applied, typed)]
const RECOGNIZED = new Map(Object.entries({
  activate: ["activation.forceState", "flag", flagValue, (applied) => {
    applied.activation.forceState = "activate";
  }],
  dont_activate: ["activation.forceState", "flag", flagValue, (applied) => {
    applied.activation.forceState = "suppress";
  }],
  activate_only_after: ["activation.activateOnlyAfter", "int",
    (text) => intValue(text, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    (applied, value) => { applied.activation.activateOnlyAfter = value; }],
  is_greeting: ["activation.greetingIndex", "int",
    (text) => intValue(text, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    (applied, value) => { applied.activation.greetingIndex = value; }],
  scan_depth: ["activation.scanDepthMessages", "int",
    (text) => intValue(text, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    (applied, value) => { applied.activation.scanDepthMessages = value; }],
  keep_activate_after_match: ["activation.statefulMatch", "flag", flagValue, (applied) => {
    applied.activation.statefulMatch = "keep";
  }],
  dont_activate_after_match: ["activation.statefulMatch", "flag", flagValue, (applied) => {
    applied.activation.statefulMatch = "suppress";
  }],
  role: ["insertion.role", "enum",
    (text) => (ROLE_VALUES.has(text) ? text : INVALID),
    (applied, value) => { applied.insertion.role = value; }],
  position: ["insertion.position", "position",
    (text) => (POSITION_VALUES.has(text) ? POSITION_VALUES.get(text) : INVALID),
    (applied, value) => { applied.insertion.position = value; }],
  depth: ["insertion.depth", "int",
    (text) => intValue(text, C.MAX_WORLD_BOOK_DEPTH),
    (applied, value) => {
      applied.insertion.depth = value;
      applied.insertion.reverseDepth = false;
    }],
  reverse_depth: ["insertion.reverseDepth", "int",
    (text) => intValue(text, C.MAX_WORLD_BOOK_DEPTH),
    (applied, value) => {
      applied.insertion.depth = value;
      applied.insertion.reverseDepth = true;
    }],
}));
// CCV3 example spelling + common shorthand aliases for the activation-count
// decorator; they compile to the same target as @@activate_only_after.
for (const alias of ["activate_after", "activate_count"]) {
  RECOGNIZED.set(alias, RECOGNIZED.get("activate_only_after"));
}

function resolveLimits(overrides) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  const resolved = {};
  for (const [key, hard] of Object.entries(WORLD_BOOK_DECORATOR_LIMITS)) {
    const candidate = source[key];
    resolved[key] = Number.isSafeInteger(candidate) && candidate >= 1
      ? Math.min(hard, candidate)
      : hard;
  }
  return resolved;
}

function parseItem(line, index, isFallback) {
  const rest = line.slice(isFallback ? 3 : 2);
  const match = /^(\S*)([\s\S]*)$/.exec(rest);
  return {
    line, index, isFallback, name: match[1], valueText: match[2].trim(),
    node: null, typed: INVALID, spec: null,
  };
}

/**
 * Compile the leading V3 decorator lines of an entry's content.
 *
 * @param {string} content raw entry content
 * @param {object} [options] {limits} may only tighten the hard bounds
 * @returns {{content: string, directives: Array, applied: object,
 *   inert: Array, reports: Array}}
 *   - directives: typed AST, one node per parsed decorator line:
 *     {name, kind, value, raw, applied, reason}
 *   - applied: normalized entry field overrides {activation, insertion}
 *   - inert: [{line, reason}] decorator lines preserved in the content
 *   - reports: [{index, name, status, reason, raw}] for compatibility reporting
 */
function compileWorldBookDecorators(content, options = {}) {
  const limits = resolveLimits(options.limits);
  const empty = { activation: {}, insertion: {} };
  if (typeof content !== "string" || !content.startsWith("@@")) {
    return { content: typeof content === "string" ? content : "", directives: [], applied: empty, inert: [], reports: [] };
  }
  const lines = content.split("\n");

  // ------------------------------------------------------------ parse ----
  const items = [];
  let consumed = 0;
  while (consumed < lines.length
      && items.length < limits.maxDecoratorLines
      && lines[consumed].startsWith("@@")) {
    const line = lines[consumed];
    items.push(parseItem(line, consumed, line.startsWith("@@@")));
    consumed += 1;
  }
  // Chains: a `@@` primary starts a chain; following `@@@` lines join it. An
  // orphan `@@@` with no active chain starts its own chain.
  const chains = [];
  for (const item of items) {
    if (!item.isFallback || chains.length === 0) chains.push({ items: [], winner: null });
    chains.at(-1).items.push(item);
  }

  // -------------------------------------------------------- evaluate -----
  const directives = [];
  for (const chain of chains) {
    chain.items.forEach((item, index) => {
      // Stored name/raw are capped exactly like sanitizeCompiledDecorators so
      // re-normalization round-trips byte-identically (idempotency); inert
      // lines keep their full text because they are fidelity data mirrored
      // into preservedDecorators and the insertable content.
      const node = {
        name: item.name.slice(0, C.MAX_WORLD_BOOK_SHORT_STRING_CHARS),
        kind: "unknown",
        value: null,
        raw: item.line.slice(0, C.MAX_WORLD_BOOK_SHORT_STRING_CHARS),
        applied: false,
        reason: null,
      };
      item.node = node;
      directives.push(node);
      if (index >= limits.maxChainDepth) {
        node.reason = "chain_depth_exceeded";
        return;
      }
      if (item.name.length > C.MAX_WORLD_BOOK_DECORATOR_NAME_CHARS) {
        node.reason = "unknown_decorator";
        return;
      }
      const spec = RECOGNIZED.get(item.name);
      if (!spec) {
        node.reason = "unknown_decorator";
        return;
      }
      node.kind = spec[1];
      const typed = item.valueText.length > limits.maxValueChars
        ? INVALID
        : spec[2](item.valueText);
      if (typed === INVALID) {
        node.reason = "invalid_value";
        return;
      }
      item.typed = typed;
      item.spec = spec;
      if (chain.winner) node.reason = "fallback_superseded";
      else chain.winner = item;
    });
  }

  // ---------------------------------------------------------- apply ------
  // First chain winner per compile target applies (first-value rule); for
  // forceState, CCV3 pins @@activate above @@dont_activate at any order.
  const byTarget = new Map();
  for (const chain of chains) {
    if (!chain.winner) continue;
    const target = chain.winner.spec[0];
    const candidates = byTarget.get(target) ?? [];
    candidates.push(chain.winner);
    byTarget.set(target, candidates);
  }
  for (const [target, candidates] of byTarget) {
    let winnerIndex = 0;
    if (target === "activation.forceState") {
      const activateIndex = candidates.findIndex((item) => item.name === "activate");
      if (activateIndex >= 0) winnerIndex = activateIndex;
    }
    candidates.forEach((item, index) => {
      if (index === winnerIndex) item.node.applied = true;
      else item.node.reason = "duplicate_name";
    });
  }
  // CCV3 precedence: an applied @@position shadows @@depth/@@reverse_depth;
  // an applied @@depth shadows @@reverse_depth.
  const winnerFor = (target) => (byTarget.get(target) ?? []).find((item) => item.node.applied) ?? null;
  const positionWinner = winnerFor("insertion.position");
  const depthWinner = winnerFor("insertion.depth");
  const reverseWinner = winnerFor("insertion.reverseDepth");
  for (const [item, reason] of [
    [depthWinner, positionWinner ? "shadowed_by_position" : null],
    [reverseWinner, positionWinner ? "shadowed_by_position" : depthWinner ? "shadowed_by_depth" : null],
  ]) {
    if (item && reason) {
      item.node.applied = false;
      item.node.reason = reason;
    }
  }

  const applied = { activation: {}, insertion: {} };
  for (const chain of chains) {
    for (const item of chain.items) {
      if (!item.node.applied) continue;
      item.spec[3](applied, item.typed);
      item.node.value = item.typed === true ? null : item.typed;
    }
  }
  // Depth implies at-depth insertion unless an explicit @@position applied.
  if (applied.insertion.depth !== undefined && !positionWinner) {
    applied.insertion.position = "at_depth";
  }

  // ---------------------------------------------------------- strip ------
  // Strip by consumed line INDEX, never by line text: an inert line that is
  // textually identical to a stripped line (e.g. a chain-depth-exceeded
  // `@@@depth 3` after a winning chain's `@@@depth 3`) must survive.
  const stripped = new Set();
  const inert = [];
  for (const chain of chains) {
    for (const item of chain.items) {
      if (!chain.winner) {
        inert.push({ line: item.line, reason: item.node.reason });
        continue;
      }
      stripped.add(item.index);
      // Non-applied items of a WINNING chain are stripped, not preserved:
      // reclassify unknown/invalid items as superseded so the report matches
      // the behavior (they lost the chain's fallback evaluation).
      if (!item.node.applied
          && (item.node.reason === "unknown_decorator"
            || item.node.reason === "invalid_value")) {
        item.node.reason = "fallback_superseded";
      }
    }
  }
  const kept = lines.slice(0, consumed).filter((line, index) => !stripped.has(index));
  const strippedContent = [...kept, ...lines.slice(consumed)].join("\n");

  const reports = directives.map((node, index) => ({
    index,
    name: node.name,
    status: node.applied ? "applied" : "inert",
    reason: node.reason,
    raw: node.raw,
  }));

  return { content: strippedContent, directives, applied, inert, reports };
}

// Defensive shape check for an already-compiled record (stored canonical
// entries re-normalized from disk). Only well-formed keys survive; the
// model's merge pass re-validates every value against the field normalizers.
function sanitizeCompiledDecorators(record, maximum = C.MAX_WORLD_BOOK_PRESERVED_DECORATORS) {
  const source = record && typeof record === "object" ? record : {};
  const directives = (Array.isArray(source.directives) ? source.directives : [])
    .slice(0, maximum)
    .filter((node) => node && typeof node === "object" && typeof node.name === "string")
    .map((node) => ({
      name: String(node.name).slice(0, C.MAX_WORLD_BOOK_SHORT_STRING_CHARS),
      kind: typeof node.kind === "string" ? node.kind : "unknown",
      value: typeof node.value === "string"
        ? node.value.slice(0, C.MAX_WORLD_BOOK_SHORT_STRING_CHARS)
        : (typeof node.value === "number" ? node.value : null),
      raw: typeof node.raw === "string" ? node.raw.slice(0, C.MAX_WORLD_BOOK_SHORT_STRING_CHARS) : "",
      applied: node.applied === true,
      reason: typeof node.reason === "string" ? node.reason : null,
    }));
  const inert = (Array.isArray(source.inert) ? source.inert : [])
    .slice(0, maximum)
    .filter((item) => item && typeof item === "object" && typeof item.line === "string")
    .map((item) => ({
      // Full line text, never truncated: inert lines are fidelity data
      // mirrored into preservedDecorators and the insertable content.
      line: item.line,
      reason: typeof item.reason === "string" ? item.reason : "unknown_decorator",
    }));
  const rawApplied = source.applied && typeof source.applied === "object" ? source.applied : {};
  const applied = { activation: {}, insertion: {} };
  for (const section of ["activation", "insertion"]) {
    const values = rawApplied[section];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (["string", "number", "boolean"].includes(typeof value)) applied[section][key] = value;
    }
  }
  return { directives, inert, applied };
}

/**
 * Entry-level decorator resolution for the normalized model (§10.4.7 build
 * step). A fresh raw entry is compiled from its content; an already-compiled
 * entry (stored canonical, or the import mapper, which reports decorator
 * compatibility itself) passes its decision record through the defensive
 * sanitizer. Re-normalization is idempotent because the compiled record
 * round-trips unchanged.
 *
 * @returns {{content: string, record: {directives, inert, applied},
 *   preservedDecorators: string[]}}
 */
function resolveEntryDecorators(entry, rawContent) {
  const fresh = !entry.decorators || typeof entry.decorators !== "object"
    || Array.isArray(entry.decorators);
  const compiled = fresh
    ? compileWorldBookDecorators(rawContent)
    : { content: rawContent, ...sanitizeCompiledDecorators(entry.decorators) };
  const base = Array.isArray(entry.preservedDecorators) ? entry.preservedDecorators : [];
  const preservedDecorators = fresh
    ? [...base, ...compiled.inert.map((item) => item.line)]
    : base;
  if (preservedDecorators.length > C.MAX_WORLD_BOOK_PRESERVED_DECORATORS) {
    throw codedError(
      "WORLD_BOOK_LIMIT_EXCEEDED",
      `World book preservedDecorators exceeds ${C.MAX_WORLD_BOOK_PRESERVED_DECORATORS}`,
      {
        limitsVersion: C.MAX_WORLD_BOOK_LIMITS_VERSION,
        limitKind: "preservedDecorators",
        limit: C.MAX_WORLD_BOOK_PRESERVED_DECORATORS,
        actual: preservedDecorators.length,
      },
    );
  }
  return {
    content: compiled.content,
    record: {
      directives: compiled.directives,
      inert: compiled.inert,
      applied: compiled.applied,
    },
    preservedDecorators,
  };
}

module.exports = {
  compileWorldBookDecorators,
  resolveEntryDecorators,
  sanitizeCompiledDecorators,
  WORLD_BOOK_DECORATOR_LIMITS,
};
