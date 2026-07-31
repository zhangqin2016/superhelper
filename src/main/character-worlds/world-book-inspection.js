"use strict";

/**
 * Read-only world-book inspection summaries (Phase 2A, Task WB-6; design
 * spec §15/§16). Pure whitelist shaping for the IPC bridge: NO raw card
 * content crosses — entry content, activation keys, preserved payloads, and
 * decorator raw lines stay in the main process. The renderer receives ids,
 * counts, enums, and hashes only. Every builder is defensive against
 * malformed stored data and never throws.
 */

const MAX_ENTRY_SUMMARIES = 200;
const MAX_SUMMARY_ID_CHARS = 128;
const MAX_DECORATOR_NAME_CHARS = 64;
const MAX_APPLIED_DECORATOR_NAMES = 8;
// Positions the runtime cannot represent exactly: they compile into the
// documented lower-authority tail bucket with safe_behavior (§10.3.1).
const SAFE_BEHAVIOR_POSITIONS = new Set(["at_depth", "outlet"]);

function text(value, maximum = MAX_SUMMARY_ID_CHARS) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function entriesOf(revision) {
  return Array.isArray(revision?.canonical?.entries) ? revision.canonical.entries : [];
}

function directivesOf(entry) {
  return Array.isArray(entry?.decorators?.directives) ? entry.decorators.directives : [];
}

function appliedDecoratorNames(entry) {
  return directivesOf(entry)
    .filter((node) => node?.applied === true && typeof node?.name === "string")
    .slice(0, MAX_APPLIED_DECORATOR_NAMES)
    .map((node) => node.name.slice(0, MAX_DECORATOR_NAME_CHARS));
}

function inertDecoratorCount(entry) {
  return directivesOf(entry).filter((node) => node?.applied !== true).length;
}

function hasPreservedExtensions(entry) {
  const extensions = entry?.preservedExtensions;
  return Boolean(
    extensions
    && typeof extensions === "object"
    && !Array.isArray(extensions)
    && Object.keys(extensions).length > 0,
  );
}

/** Entity summary shared by world-book:list and world-book:get. */
function summarizeWorldBookEntity(entity, currentRevision) {
  const entries = currentRevision ? entriesOf(currentRevision) : null;
  return {
    id: text(entity?.id),
    name: text(entity?.displayName, 256),
    // null when the current revision row is missing/unreadable — the list
    // stays readable instead of failing the whole bridge call.
    entryCount: entries ? entries.length : null,
    currentRevisionId: text(entity?.currentRevisionId),
    archivedAt: typeof entity?.archivedAt === "string" ? entity.archivedAt : null,
  };
}

/** Immutable revision metadata (provenance kind/format/container only). */
function summarizeRevisionMetadata(revision) {
  const source = revision?.source && typeof revision.source === "object" ? revision.source : {};
  return {
    id: text(revision?.id),
    worldBookId: text(revision?.worldBookId),
    revisionNumber: count(revision?.revisionNumber),
    contentHash: text(revision?.contentHash, 128),
    revisionHash: text(revision?.revisionHash, 128),
    source: {
      kind: text(source.kind),
      format: text(source.format),
      container: text(source.container),
    },
    createdAt: typeof revision?.createdAt === "string" ? revision.createdAt : null,
  };
}

/**
 * Compatibility/decorator report over the current revision: counts and
 * enums only. Applied vs inert decorators mirror the §10.4.7 record;
 * regex/vectorized entries are reported inert (Phase 2A never evaluates
 * them); unsupported positions count toward the safe-behavior bucket.
 */
function summarizeCompatibilityReport(revision) {
  const entries = entriesOf(revision);
  const report = {
    entryCount: entries.length,
    enabledCount: 0,
    constantCount: 0,
    appliedDecoratorCount: 0,
    inertDecoratorCount: 0,
    preservedDecoratorEntryCount: 0,
    preservedExtensionEntryCount: 0,
    safeBehaviorPositionCount: 0,
    regexEntryCount: 0,
    vectorizedEntryCount: 0,
  };
  for (const entry of entries) {
    if (entry?.enabled !== false) report.enabledCount += 1;
    if (entry?.activation?.constant === true) report.constantCount += 1;
    report.appliedDecoratorCount += directivesOf(entry)
      .filter((node) => node?.applied === true).length;
    report.inertDecoratorCount += inertDecoratorCount(entry);
    if (Array.isArray(entry?.preservedDecorators) && entry.preservedDecorators.length > 0) {
      report.preservedDecoratorEntryCount += 1;
    }
    if (hasPreservedExtensions(entry)) report.preservedExtensionEntryCount += 1;
    if (SAFE_BEHAVIOR_POSITIONS.has(entry?.insertion?.position)) {
      report.safeBehaviorPositionCount += 1;
    }
    if (entry?.activation?.useRegex === true) report.regexEntryCount += 1;
    if (entry?.activation?.vectorized === true) report.vectorizedEntryCount += 1;
  }
  return report;
}

/** world-book:get detail: entity summary + revision metadata + report. */
function summarizeWorldBookDetail(entity, currentRevision) {
  return {
    ...summarizeWorldBookEntity(entity, currentRevision),
    revision: currentRevision ? summarizeRevisionMetadata(currentRevision) : null,
    report: currentRevision ? summarizeCompatibilityReport(currentRevision) : null,
  };
}

/** One bounded entry summary — never content, keys, or preserved payloads. */
function summarizeEntry(entry) {
  const activation = entry?.activation && typeof entry.activation === "object" ? entry.activation : {};
  const insertion = entry?.insertion && typeof entry.insertion === "object" ? entry.insertion : {};
  return {
    id: text(entry?.id),
    enabled: entry?.enabled !== false,
    constant: activation.constant === true,
    primaryKeyCount: Array.isArray(activation.primaryKeys) ? activation.primaryKeys.length : 0,
    secondaryKeyCount: Array.isArray(activation.secondaryKeys) ? activation.secondaryKeys.length : 0,
    selective: activation.selective === true,
    probability: Number.isFinite(activation.probability) ? activation.probability : 100,
    position: text(insertion.position) || "before_character",
    order: count(insertion.order),
    appliedDecorators: appliedDecoratorNames(entry),
    inertDecoratorCount: inertDecoratorCount(entry),
    hasPreservedExtensions: hasPreservedExtensions(entry),
  };
}

/** world-book:get-revision payload: metadata + capped entry summaries. */
function summarizeWorldBookRevision(revision) {
  const entries = entriesOf(revision);
  return {
    ...summarizeRevisionMetadata(revision),
    entryCount: entries.length,
    truncated: entries.length > MAX_ENTRY_SUMMARIES,
    entries: entries.slice(0, MAX_ENTRY_SUMMARIES).map(summarizeEntry),
  };
}

module.exports = {
  MAX_ENTRY_SUMMARIES,
  summarizeWorldBookDetail,
  summarizeWorldBookEntity,
  summarizeWorldBookRevision,
};
