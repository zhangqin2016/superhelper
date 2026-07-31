"use strict";

/**
 * Per-turn world-book wiring (§10.4, Phase 2 Task WB-4) — the impure shell
 * around the pure resolver + compiler:
 *
 * - prepareTurnWorldBook resolves the IMMUTABLE book revision pinned by the
 *   admitted character revision (characterBookRevisionId — never the current
 *   entity state), builds the bounded scan corpus from the canonical session
 *   messages (MessageStore.getRecentWithSeq), and reads the durable
 *   timed-effect checkpoint.
 * - compileTurnWorldCharacterContext runs the compiler with that input and
 *   derives the pending checkpoint the turn state carries (metadata only).
 * - persistTurnWorldBookCheckpoint is the durable half of §10.4.6: called by
 *   the terminal finalizer ONLY after a successful turn.completed terminal
 *   CAS, it writes the pending checkpoint transactionally with an optimistic
 *   version guard.
 *
 * Replay semantics (documented choice): a turn's activation is RECOMPUTED
 * DETERMINISTICALLY from the pre-turn durable checkpoint — the resolver is
 * pure, so a retry with the same seed identity and canonical messages replays
 * a byte-identical activation. The stored activationFingerprint + turnId are
 * audit metadata, never required inputs.
 *
 * Crash window (documented): persistTurnWorldBookCheckpoint runs as a
 * SEPARATE, LATER transaction than the terminal CAS that finalized the turn.
 * A crash in between leaves a durable completed turn with no checkpoint row —
 * bounded and self-healing: the next turn recomputes from the pre-turn
 * checkpoint and its own successful finalization writes the row. Timed
 * effects may fire one turn late, never wrong.
 *
 * Response variants (DEFERRED to Phase 3, §12.1): §10.4.6 requires variant
 * selection to restore/invalidate checkpoints at the retained turn boundary;
 * Phase 2A has no response-variant surface, so no hook exists yet. Rewind
 * invalidation IS wired (session-manager.deleteMessagesFromTurn).
 *
 * Every step fails open (§16): a missing/corrupt book revision, an unreadable
 * store, or a checkpoint write conflict never breaks the turn — the character
 * compiles without world entries and the miss is a metadata-only diagnostic.
 */

const { compileCharacterContext } = require("./context-compiler");
const { buildScanCorpus, resolveScanWindowMessages } = require("./world-book-corpus");

function profileOf(revision) {
  for (const candidate of [revision?.canonical?.profile, revision?.canonical, revision?.profile]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function cleanField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * @returns {null} no book pinned
 *   | {diagnostic: string} fail-open reason (metadata only)
 *   | {input: object, baseVersion: number} compiler-ready worldBook input
 */
function prepareTurnWorldBook({
  repository,
  store = null,
  ownerScope,
  sessionId,
  turnId,
  revision,
  compatibilityProfile,
} = {}) {
  const bookRevisionId = typeof revision?.characterBookRevisionId === "string"
    && revision.characterBookRevisionId
    ? revision.characterBookRevisionId
    : "";
  if (!bookRevisionId) return null;
  if (!repository || typeof repository.getWorldBookRevision !== "function") {
    return { diagnostic: "world_book_repository_unavailable" };
  }
  const bookRevision = repository.getWorldBookRevision(ownerScope, bookRevisionId);
  if (!bookRevision?.canonical || !Array.isArray(bookRevision.canonical.entries)) {
    return { diagnostic: "world_book_revision_missing" };
  }
  // Canonical messages carry the committed sequence numbers the timed gates
  // measure against (§10.4.1). The fetch is bounded by the resolved scan
  // window (never the hard cap); an unreadable store degrades to an empty
  // corpus — constant/sticky entries still resolve, keys simply never match.
  let messages = [];
  try {
    if (store && typeof store.getRecentWithSeq === "function") {
      messages = store.getRecentWithSeq(
        sessionId,
        resolveScanWindowMessages(bookRevision.canonical.scanPolicy, null),
      );
    }
  } catch {
    messages = [];
  }
  const profile = profileOf(revision) || {};
  const corpus = buildScanCorpus({
    messages,
    // Matching sources are matchable only, never inserted; entries must
    // still opt in per-source via activation.matchSources (§10.4.1 step 4).
    matchingSources: {
      description: cleanField(profile.description),
      personality: cleanField(profile.personality),
      scenario: cleanField(profile.scenario),
      creatorNotes: cleanField(profile.creatorNotes),
    },
    scanPolicy: bookRevision.canonical.scanPolicy,
  });
  let checkpoint = null;
  let baseVersion = 0;
  if (typeof repository.readWorldBookCheckpoint === "function") {
    const stored = repository.readWorldBookCheckpoint({
      ownerScope, sessionId, worldBookRevisionId: bookRevisionId,
    });
    if (stored) {
      checkpoint = stored.checkpoint;
      baseVersion = stored.version;
    }
  }
  return {
    input: {
      revision: bookRevision,
      corpus,
      checkpoint,
      seedIdentity: { ownerScope, sessionId, turnId },
      compatibilityProfile,
    },
    baseVersion,
  };
}

/**
 * Compile the turn's character context with its pinned world book (if any).
 * Returns {compiled, pendingCheckpoint, diagnostic} — pendingCheckpoint is
 * the metadata-only package the turn state carries to the terminal
 * finalizer; it is null whenever the world book did not engage.
 *
 * Persona (P2B-2): the IMMUTABLE persona revision named by the admitted
 * snapshot's personaRevisionId is resolved here — never the current entity
 * state. A missing/corrupt/throwing persona read fails open (§16): the
 * character compiles without the persona block and the compiler records the
 * metadata-only PERSONA_REVISION_MISSING warning.
 */
function compileTurnWorldCharacterContext({
  repository,
  store = null,
  ownerScope,
  sessionId,
  turnId,
  snapshot,
  revision,
  baseInput = {},
  log = null,
} = {}) {
  let worldBook = null;
  let baseVersion = 0;
  let diagnostic = null;
  try {
    const prepared = prepareTurnWorldBook({
      repository, store, ownerScope, sessionId, turnId, revision,
      compatibilityProfile: snapshot?.compatibilityProfile,
    });
    if (prepared?.diagnostic) {
      diagnostic = prepared.diagnostic;
      log?.warn?.("world book input failed open: %s", diagnostic);
    } else if (prepared?.input) {
      worldBook = prepared.input;
      baseVersion = prepared.baseVersion;
    }
  } catch (err) {
    diagnostic = "world_book_prepare_failed";
    log?.warn?.("world book input failed open: %s", err?.message || err);
  }
  let persona = null;
  const personaRevisionId = typeof snapshot?.personaRevisionId === "string"
    && snapshot.personaRevisionId
    ? snapshot.personaRevisionId
    : "";
  if (personaRevisionId) {
    try {
      const personaRevision = typeof repository?.getPersonaRevision === "function"
        ? repository.getPersonaRevision(ownerScope, personaRevisionId)
        : null;
      if (personaRevision?.canonical) {
        persona = { revision: personaRevision };
      } else {
        log?.warn?.("persona input failed open: %s", "persona_revision_missing");
      }
    } catch (err) {
      log?.warn?.("persona input failed open: %s", err?.message || err);
    }
  }
  const compiled = compileCharacterContext({ ...baseInput, snapshot, revision, worldBook, persona });
  const pendingCheckpoint = compiled?.status === "compiled" && compiled.worldBook
    ? {
        ownerScope,
        sessionId,
        worldBookRevisionId: compiled.worldBook.revisionId,
        checkpoint: compiled.worldBook.nextCheckpoint,
        turnId,
        activationFingerprint: compiled.worldBook.activationFingerprint,
        expectedVersion: baseVersion,
      }
    : null;
  return { compiled, pendingCheckpoint, diagnostic };
}

/**
 * Durable half of §10.4.6 — persist the turn's pending checkpoint. Callers
 * (the terminal finalizer) invoke this ONLY on a successful turn.completed
 * terminal CAS. A conflict or store error fails open: the next turn simply
 * re-reads the last durable checkpoint. Returns true when the row was written.
 */
function persistTurnWorldBookCheckpoint({ repository, pending, log = null } = {}) {
  try {
    if (!repository || typeof repository.writeWorldBookCheckpoint !== "function") return false;
    if (!pending || typeof pending !== "object") return false;
    repository.writeWorldBookCheckpoint({
      ownerScope: pending.ownerScope,
      sessionId: pending.sessionId,
      worldBookRevisionId: pending.worldBookRevisionId,
      checkpoint: pending.checkpoint,
      turnId: pending.turnId,
      activationFingerprint: pending.activationFingerprint || "",
      expectedVersion: pending.expectedVersion ?? null,
    });
    return true;
  } catch (err) {
    log?.warn?.(
      "world book checkpoint persist failed open: %s",
      typeof err?.code === "string" ? err.code : err?.message || err,
    );
    return false;
  }
}

module.exports = {
  compileTurnWorldCharacterContext,
  persistTurnWorldBookCheckpoint,
  prepareTurnWorldBook,
};
