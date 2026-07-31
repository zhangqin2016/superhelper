#!/usr/bin/env node
/**
 * Character Worlds deterministic concurrency stress (Task 11, plan Step 2).
 *
 * A seeded PRNG scheduler executes 10,000 randomized operations across 32
 * sessions (4 owners × 8 sessions) over the REAL MessageStore +
 * CharacterWorldsRepository + SessionManager admission stack in a tmp dir
 * (harness mirrors test-character-binding-isolation.mjs):
 *
 *   bind A / admit turn / bind B / queue scheduled turn / steer / retry /
 *   restart-reopen database / archive character / read snapshot
 *
 * Phase 2A (WB-6) adds world-book operations to the same seeded mix:
 *
 *   import embedded book (dedup + archived-book reimport) / activate a pinned
 *   book per turn / checkpoint read+write / rewind invalidation
 *
 * Invariants (any violation fails the test):
 * - every admitted turn resolves only its exact stored session/revision/
 *   version: its pinned snapshot equals the binding state linearized at
 *   admission time, replayed against the durable binding-event history;
 * - duplicate binding event versions for a session fail;
 * - cross-session / cross-owner revision references fail;
 * - mutable queued snapshots fail (admission metadata and queue recovery are
 *   deep-frozen; mutation attempts throw);
 * - source inheritance (steer/retry) never re-reads the current binding and
 *   cross-session sources fall back to the native fallback snapshot;
 * - world-book checkpoints persist ONLY on the successful-finalization path
 *   (failed turns and stale-version writes leave the durable row untouched),
 *   durable checkpoint versions advance monotonically by exactly one per
 *   committed turn (sticky seq monotonicity), activation replays are
 *   byte-identical for identical inputs, and rewind purges every checkpoint
 *   row for the rewound session.
 *
 * Determinism: the same seed drives every choice (the production counter PRNG
 * from macro-prng.js); the whole simulation runs TWICE and the normalized
 * journals + SHA-256 fingerprints of sampled admissions must be identical.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const SEED = "character-worlds-concurrency-stress:v1";
const TOTAL_OPS = 10_000;
const OWNER_COUNT = 4;
const SESSIONS_PER_OWNER = 8;
const SESSION_COUNT = OWNER_COUNT * SESSIONS_PER_OWNER;
const CHARS_PER_OWNER = 3;
const BOOKS_PER_OWNER = 2;

const { MessageStore } = require("../src/main/store/message-store.js");
const SessionManager = require("../src/main/session-manager.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  importEmbeddedWorldBook,
} = require("../src/main/character-worlds/world-book-repository.js");
const {
  compileTurnWorldCharacterContext,
  persistTurnWorldBookCheckpoint,
} = require("../src/main/character-worlds/turn-world-book.js");
const {
  createCounterPrng,
  uniformInt,
} = require("../src/main/character-worlds/macro-prng.js");
const {
  createQueueRecoveryEnvelope,
} = require("../src/main/turn-queue-recovery-envelope.js");

function expectedReady(version, revisionId, profile) {
  return {
    schemaVersion: 1,
    mode: "character",
    bindingVersion: version,
    characterRevisionId: revisionId,
    personaRevisionId: null,
    compatibilityProfile: profile,
    snapshotStatus: "ready",
  };
}

function expectedFallback() {
  return {
    schemaVersion: 1,
    mode: "native",
    bindingVersion: 0,
    characterRevisionId: null,
    personaRevisionId: null,
    compatibilityProfile: null,
    snapshotStatus: "fallback",
  };
}

function sourceOf(name) {
  return {
    kind: "created",
    format: "lily",
    container: "json",
    originalFileName: `${name}.json`,
  };
}

/**
 * Run one seeded simulation. Returns the normalized journal (all random ids
 * replaced by deterministic slot indices) and its fingerprint.
 */
function runSimulation() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-character-stress-"));
  const journal = [];
  try {
    process.env.LILY_USER_DATA_DIR = tmp;
    const prng = createCounterPrng(SEED, 0);
    const pick = (upper) => {
      const value = uniformInt(prng, upper);
      assert.notEqual(value, null, "seeded scheduler draw must succeed");
      return value;
    };

    const dbPath = path.join(tmp, "messages.db");
    const blobDir = path.join(tmp, "blobs");
    let store = new MessageStore(dbPath, blobDir);
    let repository = new CharacterWorldsRepository(store);

    const owners = Array.from({ length: OWNER_COUNT }, (_, i) => `profile:stress-owner-${i}`);
    // characters[ownerIdx][slot] = { entityId, revisionId }
    const characters = owners.map((owner, ownerIdx) => (
      Array.from({ length: CHARS_PER_OWNER }, (_, slot) => {
        const created = repository.createCharacter({
          ownerScope: owner,
          canonical: {
            schemaVersion: 1,
            name: `Char-${ownerIdx}-${slot}`,
            description: `Deterministic stress character ${ownerIdx}/${slot}.`,
          },
          source: sourceOf(`char-${ownerIdx}-${slot}`),
        });
        return {
          entityId: created.entity.id,
          revisionId: created.revision.id,
        };
      })
    ));
    const revisionSlot = new Map(); // revisionId -> [ownerIdx, slot]
    characters.forEach((chars, ownerIdx) => {
      chars.forEach((char, slot) => revisionSlot.set(char.revisionId, [ownerIdx, slot]));
    });

    // books[ownerIdx][slot] = { entityId, revisionId } — the fixed books the
    // activation/checkpoint ops pin to characters (one sticky constant entry
    // so successful turns produce meaningful timed checkpoints).
    const books = owners.map((owner, ownerIdx) => (
      Array.from({ length: BOOKS_PER_OWNER }, (_, slot) => {
        const created = repository.createWorldBook({
          ownerScope: owner,
          canonical: {
            schemaVersion: 1,
            name: `StressBook-${ownerIdx}-${slot}`,
            entries: [
              {
                id: "e-sticky",
                content: `sticky lore ${ownerIdx}/${slot}`,
                activation: { constant: true, stickyMessages: 5 },
                insertion: { position: "before_character" },
              },
              {
                id: "e-keyed",
                content: `keyed lore ${ownerIdx}/${slot}`,
                activation: { primaryKeys: [`stress-key-${ownerIdx}-${slot}`] },
              },
            ],
          },
          source: sourceOf(`book-${ownerIdx}-${slot}`),
        });
        return { entityId: created.entity.id, revisionId: created.revision.id };
      })
    ));
    const bookRevisionSlot = new Map(); // book revisionId -> [ownerIdx, slot]
    books.forEach((ownerBooks, ownerIdx) => {
      ownerBooks.forEach((book, slot) => bookRevisionSlot.set(book.revisionId, [ownerIdx, slot]));
    });

    const projectManager = {
      projects: [{ id: "project-stress", path: tmp }],
      activeProjectId: "project-stress",
      getActive() {
        return this.projects[0];
      },
      find(id) {
        return this.projects.find((project) => project.id === id) || null;
      },
    };
    const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => {
      const ownerIdx = Math.floor(i / SESSIONS_PER_OWNER);
      return {
        id: `stress-session-${i}`,
        projectId: "project-stress",
        title: `stress-session-${i}`,
        ownerScopeForTest: owners[ownerIdx],
        ownerIdx,
        messages: [],
        messageCount: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        status: "idle",
      };
    });
    const manager = new SessionManager(projectManager, {
      resolveCharacterOwnerScope: (session) => session.ownerScopeForTest,
    });
    manager.sessions = { "project-stress": sessions };
    manager.activeSessionId = sessions[0].id;
    manager._messageStore = store;
    manager._ensureImported = () => {};
    // Session-metadata persistence is irrelevant to this stress (all checks
    // run against the durable store); the rewind path calls save() after
    // deleting messages.
    manager.save = () => {};

    // Model of the world the real stack must match.
    // binding[i]: null (never bound) | { mode:"native", version } |
    //             { mode:"character", version, slot, profile, revisionId }
    const binding = sessions.map(() => null);
    // admitted[i]: [{ turnId, snap }] with snap = null | ["ready", v, slot, profile] | ["fallback"]
    const admitted = sessions.map(() => []);
    // checkpointModel: `${sessionIdx}:${bookSlot}` -> { version } — the
    // linearized model of the durable world_book_checkpoints rows.
    const checkpointModel = new Map();
    // importedBooks[ownerIdx]: [{ entityId, revisionId, signature, archived }]
    const importedBooks = owners.map(() => []);
    let bookImportSeq = 0;
    let restartCount = 0;

    function normalizeSnapshot(snapshot, hasKey) {
      if (!hasKey) return null;
      if (snapshot?.snapshotStatus === "fallback") return ["fallback"];
      assert.equal(snapshot?.snapshotStatus, "ready", "snapshot is either ready or fallback");
      const slotInfo = revisionSlot.get(snapshot.characterRevisionId);
      assert.ok(slotInfo, `snapshot revision must be a known character: ${snapshot.characterRevisionId}`);
      return ["ready", snapshot.bindingVersion, slotInfo[1], snapshot.compatibilityProfile];
    }

    function expectedSnapshotFor(sessionIdx) {
      const model = binding[sessionIdx];
      if (!model || model.mode === "native") return null;
      return expectedReady(model.version, model.revisionId, model.profile);
    }

    function verifyAdmission(session, turn, label) {
      assert.ok(turn, `${label}: admission returned a turn`);
      assert.equal(turn.sessionId, session.id, `${label}: exact session`);
      const hasKey = Object.hasOwn(turn.metadata, "characterWorlds");
      const expected = expectedSnapshotFor(sessions.indexOf(session));
      if (expected) {
        assert.deepEqual(turn.metadata.characterWorlds, expected, `${label}: exact stored revision/version`);
      } else {
        assert.equal(hasKey, false, `${label}: native turn allocates no Character Worlds metadata`);
      }
      // Mutable snapshots fail: admission metadata is deep-frozen.
      assert.equal(Object.isFrozen(turn.metadata), true, `${label}: metadata frozen`);
      if (hasKey) {
        assert.equal(Object.isFrozen(turn.metadata.characterWorlds), true, `${label}: snapshot frozen`);
        assert.throws(() => {
          turn.metadata.characterWorlds.bindingVersion = 999;
        }, TypeError, `${label}: snapshot mutation throws`);
        // Cross-owner check: a ready revision belongs to this session's owner.
        const slotInfo = revisionSlot.get(turn.metadata.characterWorlds.characterRevisionId);
        assert.equal(slotInfo[0], session.ownerIdx, `${label}: no cross-owner revision`);
      }
      // Durable re-read resolves the identical snapshot.
      const reread = store.getTurnInputByTurnId(turn.turnId);
      assert.deepEqual(
        reread.metadata.characterWorlds ?? null,
        turn.metadata.characterWorlds ?? null,
        `${label}: durable re-read is identical`,
      );
      const snap = normalizeSnapshot(turn.metadata.characterWorlds, hasKey);
      admitted[sessions.indexOf(session)].push({ turnId: turn.turnId, snap });
      return snap;
    }

    let scheduledRunSeq = 0;

    function opBind(sessionIdx) {
      const session = sessions[sessionIdx];
      const owner = session.ownerScopeForTest;
      const current = repository.getBinding(session.id, owner);
      const stale = current.bindingVersion > 0 && pick(10) === 0;
      if (stale) {
        assert.throws(
          () => repository.setBinding({
            sessionId: session.id,
            ownerScope: owner,
            expectedBindingVersion: current.bindingVersion - 1,
            next: { mode: "native" },
          }),
          (err) => err?.code === "CHARACTER_BINDING_CONFLICT",
          "stale binding version must conflict",
        );
        journal.push(["bind-conflict", sessionIdx]);
        return;
      }
      if (pick(7) === 0) {
        const committed = repository.setBinding({
          sessionId: session.id,
          ownerScope: owner,
          expectedBindingVersion: current.bindingVersion,
          next: { mode: "native" },
        });
        binding[sessionIdx] = { mode: "native", version: committed.bindingVersion };
        journal.push(["bind", sessionIdx, "native", committed.bindingVersion]);
        return;
      }
      const slot = pick(CHARS_PER_OWNER);
      const profile = `profile-${session.ownerIdx}-${slot}`;
      const committed = repository.setBinding({
        sessionId: session.id,
        ownerScope: owner,
        expectedBindingVersion: current.bindingVersion,
        next: {
          mode: "character",
          characterRevisionId: characters[session.ownerIdx][slot].revisionId,
          compatibilityProfile: profile,
        },
      });
      binding[sessionIdx] = {
        mode: "character",
        version: committed.bindingVersion,
        slot,
        profile,
        revisionId: characters[session.ownerIdx][slot].revisionId,
      };
      journal.push(["bind", sessionIdx, "character", committed.bindingVersion, slot, profile]);
    }

    function opAdmit(sessionIdx, opIndex) {
      const session = sessions[sessionIdx];
      const prior = admitted[sessionIdx];
      // Duplicate-turnId admissions: re-admitting an existing turnId must
      // resolve the ORIGINAL durable turn (idempotent), never create a second
      // row and never re-read the current binding.
      if (prior.length && pick(8) === 0) {
        const original = prior[pick(prior.length)];
        const turn = manager.admitTurnInput(session.id, {
          turnId: original.turnId,
          userText: `duplicate ${opIndex}`,
          metadata: {},
        });
        assert.equal(turn.turnId, original.turnId, `dup#${opIndex}: resolves the original turn`);
        const snap = normalizeSnapshot(
          turn.metadata.characterWorlds,
          Object.hasOwn(turn.metadata, "characterWorlds"),
        );
        assert.deepEqual(
          snap,
          original.snap,
          `dup#${opIndex}: duplicate admission keeps the original pinned snapshot`,
        );
        const rows = store.db.all("SELECT turn_id FROM turn_inputs WHERE turn_id = ?", original.turnId);
        assert.equal(rows.length, 1, `dup#${opIndex}: no second durable turn row`);
        journal.push(["dup-admit", sessionIdx, snap]);
        return;
      }
      // Cross-session duplicate turnId: the global turn_id uniqueness fails
      // closed and the original turn in the other session stays intact.
      if (pick(40) === 0) {
        const otherIdx = (sessionIdx + 1 + pick(SESSION_COUNT - 1)) % SESSION_COUNT;
        const otherPrior = admitted[otherIdx];
        if (otherPrior.length) {
          const foreign = otherPrior[pick(otherPrior.length)];
          assert.throws(
            () => manager.admitTurnInput(session.id, {
              turnId: foreign.turnId,
              userText: `cross duplicate ${opIndex}`,
              metadata: {},
            }),
            (err) => err?.code === "ADMISSION_CONFLICT_UNRESOLVED",
            `cross-dup#${opIndex}: cross-session duplicate turnId fails closed`,
          );
          const intact = store.getTurnInputByTurnId(foreign.turnId);
          assert.equal(intact.sessionId, sessions[otherIdx].id, `cross-dup#${opIndex}: original session intact`);
          const intactSnap = normalizeSnapshot(
            intact.metadata.characterWorlds,
            Object.hasOwn(intact.metadata, "characterWorlds"),
          );
          assert.deepEqual(intactSnap, foreign.snap, `cross-dup#${opIndex}: original snapshot intact`);
          journal.push(["dup-cross", sessionIdx, otherIdx]);
          return;
        }
      }
      // Occasionally forge caller-supplied character metadata; admission must
      // ignore it and pin the model binding.
      const forged = pick(6) === 0;
      const foreignRevision = characters[(session.ownerIdx + 1) % OWNER_COUNT][0].revisionId;
      const turn = manager.admitTurnInput(session.id, {
        turnId: `turn-${opIndex}`,
        userText: `stress message ${opIndex}`,
        metadata: forged
          ? { characterWorlds: { bindingVersion: 999, characterRevisionId: foreignRevision } }
          : {},
      });
      const snap = verifyAdmission(session, turn, `admit#${opIndex}`);
      journal.push(["admit", sessionIdx, snap, forged ? 1 : 0]);
    }

    function opQueue(sessionIdx, opIndex) {
      const session = sessions[sessionIdx];
      scheduledRunSeq += 1;
      const runId = `run-${scheduledRunSeq}`;
      const envelope = createQueueRecoveryEnvelope({
        item: { id: `queue-item-${opIndex}`, displayFiles: [] },
        options: {
          scheduledTaskId: `task-${sessionIdx}`,
          scheduledTaskRunId: runId,
          queueOrigin: "scheduled_task",
          queueVisibility: "background",
        },
      });
      const result = manager.admitQueuedTurnInput(session.id, {
        turnId: `turn-${opIndex}`,
        userText: `scheduled ${opIndex}`,
        metadata: {},
      }, envelope);
      assert.equal(result.ok, true, `queue#${opIndex}: admitted`);
      assert.equal(result.inserted, true, `queue#${opIndex}: inserted`);
      const snap = verifyAdmission(session, result.turn, `queue#${opIndex}`);
      const recovery = result.turn.metadata.queueRecovery;
      assert.ok(recovery, `queue#${opIndex}: queue recovery persisted`);
      assert.equal(Object.isFrozen(recovery), true, `queue#${opIndex}: queue recovery frozen`);
      assert.equal(Object.isFrozen(recovery.options), true, `queue#${opIndex}: recovery options frozen`);
      assert.throws(() => {
        recovery.options.scheduledTaskRunId = "mutated";
      }, TypeError, `queue#${opIndex}: queued snapshot mutation throws`);
      if (pick(4) === 0) {
        // Idempotent replay of the same scheduled run resolves the same turn,
        // never a second admission.
        const replay = manager.admitQueuedTurnInput(session.id, {
          turnId: `turn-${opIndex}-replay`,
          userText: `scheduled ${opIndex} replay`,
          metadata: {},
        }, envelope);
        assert.equal(replay.ok, true, `queue#${opIndex}: replay ok`);
        assert.equal(replay.duplicate, true, `queue#${opIndex}: replay is a duplicate`);
        assert.equal(replay.turn.turnId, `turn-${opIndex}`, `queue#${opIndex}: replay resolves the original turn`);
        journal.push(["queue", sessionIdx, snap, 1]);
        return;
      }
      journal.push(["queue", sessionIdx, snap, 0]);
    }

    function opInherit(sessionIdx, opIndex, kind) {
      const session = sessions[sessionIdx];
      const prior = admitted[sessionIdx];
      if (prior.length === 0) {
        opAdmit(sessionIdx, opIndex);
        return;
      }
      const crossSession = kind === "retry" && pick(5) === 0;
      let sourceTurnId;
      let expectedSnap;
      if (crossSession) {
        const otherIdx = (sessionIdx + 1 + pick(SESSION_COUNT - 1)) % SESSION_COUNT;
        const otherPrior = admitted[otherIdx];
        if (otherPrior.length === 0) {
          opAdmit(sessionIdx, opIndex);
          return;
        }
        sourceTurnId = otherPrior[pick(otherPrior.length)].turnId;
        expectedSnap = ["fallback"];
      } else {
        const source = prior[pick(prior.length)];
        sourceTurnId = source.turnId;
        expectedSnap = source.snap;
      }
      const turn = manager.admitTurnInputFromSource(session.id, {
        turnId: `turn-${opIndex}`,
        userText: `${kind} ${opIndex}`,
        metadata: {},
      }, sourceTurnId);
      const hasKey = Object.hasOwn(turn.metadata, "characterWorlds");
      if (expectedSnap === null) {
        assert.equal(hasKey, false, `${kind}#${opIndex}: source without snapshot inherits native`);
      } else if (expectedSnap[0] === "fallback") {
        assert.deepEqual(turn.metadata.characterWorlds, expectedFallback(), `${kind}#${opIndex}: fallback`);
      } else {
        const [version, slot, profile] = [expectedSnap[1], expectedSnap[2], expectedSnap[3]];
        assert.deepEqual(
          turn.metadata.characterWorlds,
          expectedReady(version, characters[session.ownerIdx][slot].revisionId, profile),
          `${kind}#${opIndex}: inherits the source turn's exact snapshot, never the current binding`,
        );
      }
      const snap = verifyAdmissionAgainst(session, turn, `${kind}#${opIndex}`);
      admitted[sessionIdx].push({ turnId: turn.turnId, snap });
      journal.push([kind, sessionIdx, snap, crossSession ? 1 : 0]);
    }

    // verifyAdmission already checks against the CURRENT model binding; for
    // inherited turns the snapshot is deliberately NOT the current binding, so
    // only the structural/durability checks apply.
    function verifyAdmissionAgainst(session, turn, label) {
      assert.equal(turn.sessionId, session.id, `${label}: exact session`);
      const hasKey = Object.hasOwn(turn.metadata, "characterWorlds");
      assert.equal(Object.isFrozen(turn.metadata), true, `${label}: metadata frozen`);
      if (hasKey) {
        assert.equal(Object.isFrozen(turn.metadata.characterWorlds), true, `${label}: snapshot frozen`);
        if (turn.metadata.characterWorlds.snapshotStatus === "ready") {
          const slotInfo = revisionSlot.get(turn.metadata.characterWorlds.characterRevisionId);
          assert.ok(slotInfo, `${label}: known revision`);
          assert.equal(slotInfo[0], session.ownerIdx, `${label}: no cross-owner revision`);
        }
      }
      const reread = store.getTurnInputByTurnId(turn.turnId);
      assert.deepEqual(
        reread.metadata.characterWorlds ?? null,
        turn.metadata.characterWorlds ?? null,
        `${label}: durable re-read is identical`,
      );
      return normalizeSnapshot(turn.metadata.characterWorlds, hasKey);
    }

    function opRestart() {
      restartCount += 1;
      store.close();
      manager._messageStore = null;
      store = new MessageStore(dbPath, blobDir);
      manager._messageStore = store;
      repository = new CharacterWorldsRepository(store);
      // Recovery proof: sampled prior admissions survive the restart with
      // byte-identical frozen snapshots. Sessions are sampled UNIFORMLY across
      // all 32 (seeded), not just the earliest ones.
      const candidates = sessions
        .map((_, i) => i)
        .filter((i) => admitted[i].length > 0);
      const samples = [];
      const sampledSessions = new Set();
      const wanted = Math.min(6, candidates.length);
      while (samples.length < wanted) {
        const idx = candidates[pick(candidates.length)];
        if (sampledSessions.has(idx)) continue;
        sampledSessions.add(idx);
        samples.push([idx, admitted[idx][pick(admitted[idx].length)]]);
      }
      for (const [sessionIdx, sample] of samples) {
        const recovered = store.getTurnInputByTurnId(sample.turnId);
        assert.ok(recovered, `restart#${restartCount}: sampled turn recovered`);
        assert.equal(recovered.sessionId, sessions[sessionIdx].id, `restart#${restartCount}: exact session`);
        const snap = normalizeSnapshot(
          recovered.metadata.characterWorlds,
          Object.hasOwn(recovered.metadata, "characterWorlds"),
        );
        assert.deepEqual(snap, sample.snap, `restart#${restartCount}: snapshot identical across restart`);
        if (snap) {
          assert.equal(Object.isFrozen(recovered.metadata.characterWorlds), true, `restart#${restartCount}: frozen`);
        }
      }
      journal.push(["restart", restartCount]);
    }

    function opArchive(sessionIdx) {
      const ownerIdx = pick(OWNER_COUNT);
      const slot = pick(CHARS_PER_OWNER);
      const archived = repository.archiveCharacter(owners[ownerIdx], characters[ownerIdx][slot].entityId);
      assert.ok(archived?.archivedAt, "archive records the archive timestamp");
      // Archiving never deletes the immutable revision admitted turns pin to.
      const revision = repository.getRevision(owners[ownerIdx], characters[ownerIdx][slot].revisionId);
      assert.ok(revision, "archived character revisions stay readable");
      journal.push(["archive", ownerIdx, slot]);
    }

    function opRead(sessionIdx) {
      const session = sessions[sessionIdx];
      const model = binding[sessionIdx];
      const current = repository.getBinding(session.id, session.ownerScopeForTest);
      if (!model) {
        assert.equal(current.mode, "native", "read: never-bound session reads native");
        assert.equal(current.bindingVersion, 0, "read: never-bound session has version 0");
      } else {
        assert.equal(current.mode, model.mode, "read: mode matches the linearized model");
        assert.equal(current.bindingVersion, model.version, "read: exact version");
        if (model.mode === "character") {
          assert.equal(current.characterRevisionId, model.revisionId, "read: exact revision");
          assert.equal(current.compatibilityProfile, model.profile, "read: exact profile");
        }
      }
      // Binding events: no duplicate versions, contiguous from 1.
      let after = 0;
      let expected = 1;
      for (;;) {
        const events = repository.getBindingEvents(session.id, session.ownerScopeForTest, { afterVersion: after, limit: 200 });
        if (!events.length) break;
        for (const event of events) {
          assert.equal(event.bindingVersion, expected, `read: event versions contiguous (${session.id})`);
          expected += 1;
          after = event.bindingVersion;
        }
        if (events.length < 200) break;
      }
      assert.equal(expected - 1, model ? model.version : 0, "read: event history matches the model version");
      journal.push(["read", sessionIdx, current.bindingVersion, current.mode]);
    }

    // --- world-book ops (Phase 2A, WB-6) -------------------------------------

    function importBook(owner, signature) {
      return repository.db.transaction(() => importEmbeddedWorldBook(repository, {
        ownerScope: owner,
        canonical: {
          schemaVersion: 1,
          name: `ImportedBook-${signature}`,
          entries: [{
            id: "e-1",
            content: `imported lore ${signature}`,
            activation: { constant: true },
          }],
        },
        source: sourceOf(signature),
      }))();
    }

    function opBookImport(ownerIdx, opIndex) {
      const owner = owners[ownerIdx];
      const candidates = importedBooks[ownerIdx];
      const variant = pick(3);
      if (variant === 0 || candidates.length === 0) {
        bookImportSeq += 1;
        const signature = `imported-${ownerIdx}-${bookImportSeq}`;
        const imported = importBook(owner, signature);
        assert.equal(imported.reused, false, `wb-import#${opIndex}: a fresh book creates a new revision`);
        candidates.push({
          entityId: imported.entityId,
          revisionId: imported.revisionId,
          signature,
          archived: false,
        });
        journal.push(["wb-import", ownerIdx, "fresh", candidates.length - 1]);
        return;
      }
      const target = candidates[pick(candidates.length)];
      if (variant === 1) {
        // Re-importing identical content dedups against the LIVE entity with
        // the same revision hash; an archived book never acquires new pins.
        const live = candidates.find((book) => book.signature === target.signature && !book.archived) || null;
        const again = importBook(owner, target.signature);
        if (live) {
          assert.equal(again.reused, true, `wb-import#${opIndex}: identical book dedups against the live entity`);
          assert.equal(again.revisionId, live.revisionId, `wb-import#${opIndex}: dedup reuses the exact revision`);
          assert.equal(again.entityId, live.entityId, `wb-import#${opIndex}: dedup reuses the exact entity`);
          journal.push(["wb-import", ownerIdx, "dedup", candidates.indexOf(live)]);
        } else {
          assert.equal(again.reused, false, `wb-import#${opIndex}: archived books never acquire new pins`);
          assert.notEqual(again.entityId, target.entityId, `wb-import#${opIndex}: reimport creates a new entity`);
          const stillArchived = repository.getWorldBook(owner, target.entityId);
          assert.ok(stillArchived?.archivedAt, `wb-import#${opIndex}: the archived entity stays archived`);
          candidates.push({
            entityId: again.entityId,
            revisionId: again.revisionId,
            signature: target.signature,
            archived: false,
          });
          journal.push(["wb-import", ownerIdx, "reimport-archived", candidates.length - 1]);
        }
        return;
      }
      const archived = repository.archiveWorldBook(owner, target.entityId);
      assert.ok(archived?.archivedAt, `wb-import#${opIndex}: archive records the archive timestamp`);
      target.archived = true;
      // Archiving never deletes the immutable revision admitted turns pin to.
      const revision = repository.getWorldBookRevision(owner, target.revisionId);
      assert.ok(revision, `wb-import#${opIndex}: archived book revisions stay readable`);
      journal.push(["wb-import", ownerIdx, "archive", candidates.indexOf(target)]);
    }

    function opBookActivate(sessionIdx, opIndex) {
      const session = sessions[sessionIdx];
      const owner = session.ownerScopeForTest;
      const bookSlot = pick(BOOKS_PER_OWNER);
      const book = books[session.ownerIdx][bookSlot];
      const character = characters[session.ownerIdx][pick(CHARS_PER_OWNER)];
      const charRevision = repository.getRevision(owner, character.revisionId);
      const revision = { ...charRevision, characterBookRevisionId: book.revisionId };
      const snapshot = {
        schemaVersion: 1,
        mode: "character",
        bindingVersion: 1,
        characterRevisionId: character.revisionId,
        compatibilityProfile: `profile-wb-${session.ownerIdx}`,
        snapshotStatus: "ready",
      };
      const turnId = `wb-turn-${opIndex}`;
      const input = {
        repository, store, ownerScope: owner, sessionId: session.id, turnId,
        snapshot, revision,
        baseInput: { userText: `wb ${opIndex}` },
      };
      const result = compileTurnWorldCharacterContext(input);
      assert.equal(result.compiled?.status, "compiled", `wb-activate#${opIndex}: context compiles`);
      assert.ok(result.pendingCheckpoint, `wb-activate#${opIndex}: pending checkpoint rides the turn`);
      // The resolver is pure: an immediate replay with identical inputs is
      // byte-identical (retry semantics, §10.4.6).
      const replay = compileTurnWorldCharacterContext(input);
      assert.equal(
        replay.compiled.worldBook?.activationFingerprint,
        result.compiled.worldBook?.activationFingerprint,
        `wb-activate#${opIndex}: identical inputs replay a byte-identical activation`,
      );
      const key = `${sessionIdx}:${bookSlot}`;
      const model = checkpointModel.get(key) || { version: 0 };
      const readStored = () => repository.readWorldBookCheckpoint({
        ownerScope: owner, sessionId: session.id, worldBookRevisionId: book.revisionId,
      });
      const outcome = pick(5);
      if (outcome === 0) {
        // Failed turn: the pending checkpoint is NEVER persisted (the terminal
        // finalizer only writes on a successful turn.completed). The durable
        // row must be byte-untouched.
        const stored = readStored();
        assert.equal(stored ? stored.version : 0, model.version, `wb-activate#${opIndex}: failed turn left no checkpoint`);
        if (stored) {
          assert.notEqual(stored.turnId, turnId, `wb-activate#${opIndex}: failed turn id never recorded`);
        }
        journal.push(["wb-activate", sessionIdx, bookSlot, "failed", model.version]);
        return;
      }
      if (outcome === 1 && model.version > 0) {
        // Stale optimistic version: the guarded write conflicts and fails
        // open; the durable row stays at the model version.
        const stale = persistTurnWorldBookCheckpoint({
          repository,
          pending: { ...result.pendingCheckpoint, expectedVersion: model.version + 5 },
        });
        assert.equal(stale, false, `wb-activate#${opIndex}: stale checkpoint write conflicts`);
        const stored = readStored();
        assert.equal(stored.version, model.version, `wb-activate#${opIndex}: conflict left the row untouched`);
        journal.push(["wb-activate", sessionIdx, bookSlot, "conflict", model.version]);
        return;
      }
      // Successful finalization: the pending checkpoint persists and the
      // durable version advances by exactly one (sticky seq monotonicity).
      assert.equal(
        result.pendingCheckpoint.expectedVersion,
        model.version,
        `wb-activate#${opIndex}: the turn read the pre-turn durable checkpoint`,
      );
      const written = persistTurnWorldBookCheckpoint({ repository, pending: result.pendingCheckpoint });
      assert.equal(written, true, `wb-activate#${opIndex}: successful turn persists its checkpoint`);
      const stored = readStored();
      assert.equal(stored.version, model.version + 1, `wb-activate#${opIndex}: checkpoint version advances monotonically`);
      assert.equal(stored.turnId, turnId, `wb-activate#${opIndex}: the committed turn id is recorded`);
      checkpointModel.set(key, { version: stored.version });
      // Journal a NORMALIZED activation record: the compiled
      // activationFingerprint covers worldBookRevisionId (a random UUID per
      // simulation), so the journal carries only the deterministic parts —
      // revision content hash, activated entry ids/reasons/content hashes,
      // and the next timed checkpoint.
      const activationRecord = [
        result.compiled.worldBook.revisionHash,
        (result.compiled.activatedWorldEntries || []).map((entry) => [
          entry.entryId, entry.reason, entry.contentHash,
        ]),
        result.compiled.worldBook.nextCheckpoint,
      ];
      journal.push([
        "wb-activate", sessionIdx, bookSlot, "committed", stored.version, activationRecord,
      ]);
    }

    function opBookCheckpointRead(sessionIdx) {
      const session = sessions[sessionIdx];
      const bookSlot = pick(BOOKS_PER_OWNER);
      const book = books[session.ownerIdx][bookSlot];
      const model = checkpointModel.get(`${sessionIdx}:${bookSlot}`) || null;
      const stored = repository.readWorldBookCheckpoint({
        ownerScope: session.ownerScopeForTest,
        sessionId: session.id,
        worldBookRevisionId: book.revisionId,
      });
      if (!model) {
        assert.equal(stored, null, "wb-read: no row before any successful turn");
        journal.push(["wb-read", sessionIdx, bookSlot, 0]);
        return;
      }
      assert.ok(stored, "wb-read: the committed checkpoint row exists");
      assert.equal(stored.version, model.version, "wb-read: exact version");
      journal.push(["wb-read", sessionIdx, bookSlot, stored.version]);
    }

    function opBookRewind(sessionIdx, opIndex) {
      const session = sessions[sessionIdx];
      const turnId = `rw-turn-${opIndex}`;
      store.append(session.id, {
        role: "user",
        content: `rewind ${opIndex}`,
        turnId,
        timestamp: new Date(0).toISOString(),
      });
      // Real rewind wiring: session-manager.deleteMessagesFromTurn purges the
      // session's world-book checkpoints after the message transaction (§10.4.6).
      const removed = manager.deleteMessagesFromTurn(session.id, turnId);
      assert.ok(removed > 0, `wb-rewind#${opIndex}: the rewind deleted canonical messages`);
      let purged = 0;
      for (let slot = 0; slot < BOOKS_PER_OWNER; slot += 1) {
        const book = books[session.ownerIdx][slot];
        const stored = repository.readWorldBookCheckpoint({
          ownerScope: session.ownerScopeForTest,
          sessionId: session.id,
          worldBookRevisionId: book.revisionId,
        });
        assert.equal(stored, null, `wb-rewind#${opIndex}: rewind purged the session's checkpoints`);
        if (checkpointModel.delete(`${sessionIdx}:${slot}`)) purged += 1;
      }
      journal.push(["wb-rewind", sessionIdx, purged]);
    }

    const OP_WEIGHTS = [
      ["bind", 18],
      ["admit", 30],
      ["queue", 12],
      ["steer", 10],
      ["retry", 10],
      ["restart", 3],
      ["archive", 5],
      ["read", 12],
      ["book-import", 5],
      ["book-activate", 8],
      ["book-checkpoint-read", 4],
      ["book-rewind", 3],
    ];
    const weightTotal = OP_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);

    for (let opIndex = 0; opIndex < TOTAL_OPS; opIndex += 1) {
      let draw = pick(weightTotal);
      let kind = "read";
      for (const [name, weight] of OP_WEIGHTS) {
        if (draw < weight) {
          kind = name;
          break;
        }
        draw -= weight;
      }
      const sessionIdx = pick(SESSION_COUNT);
      switch (kind) {
        case "bind":
          opBind(sessionIdx);
          break;
        case "admit":
          opAdmit(sessionIdx, opIndex);
          break;
        case "queue":
          opQueue(sessionIdx, opIndex);
          break;
        case "steer":
          opInherit(sessionIdx, opIndex, "steer");
          break;
        case "retry":
          opInherit(sessionIdx, opIndex, "retry");
          break;
        case "restart":
          opRestart();
          break;
        case "archive":
          opArchive(sessionIdx);
          break;
        case "book-import":
          opBookImport(pick(OWNER_COUNT), opIndex);
          break;
        case "book-activate":
          opBookActivate(sessionIdx, opIndex);
          break;
        case "book-checkpoint-read":
          opBookCheckpointRead(sessionIdx);
          break;
        case "book-rewind":
          opBookRewind(sessionIdx, opIndex);
          break;
        default:
          opRead(sessionIdx);
      }
    }

    // --- global durable invariants ---------------------------------------------
    const duplicateVersions = store.db.all(
      `SELECT session_id, binding_version, COUNT(*) AS n
       FROM character_binding_events
       GROUP BY session_id, binding_version HAVING n > 1`,
    );
    assert.equal(duplicateVersions.length, 0, `duplicate binding event versions: ${JSON.stringify(duplicateVersions)}`);

    const crossOwnerBindings = store.db.all(
      `SELECT b.session_id AS sessionId
       FROM character_session_bindings b
       JOIN character_revisions r ON r.id = b.character_revision_id
       WHERE r.owner_scope <> b.owner_scope`,
    );
    assert.equal(crossOwnerBindings.length, 0, `cross-owner binding revisions: ${JSON.stringify(crossOwnerBindings)}`);

    // Every admitted turn resolves only its exact stored session/revision/
    // version: replay each pinned snapshot against the durable event history.
    const eventByVersion = new Map(); // `${sessionId}:${version}` -> event
    for (const row of store.db.all("SELECT session_id, binding_version, event_json FROM character_binding_events")) {
      eventByVersion.set(`${row.session_id}:${row.binding_version}`, JSON.parse(row.event_json));
    }
    let readyChecked = 0;
    for (const row of store.db.all("SELECT session_id, owner_scope, metadata_json FROM turn_inputs")) {
      let metadata;
      try {
        metadata = JSON.parse(row.metadata_json);
      } catch {
        continue;
      }
      const snapshot = metadata?.characterWorlds;
      if (!snapshot) continue;
      assert.equal(snapshot.snapshotStatus === "ready" || snapshot.snapshotStatus === "fallback", true,
        `turn snapshot is ready or fallback: ${JSON.stringify(snapshot)}`);
      if (snapshot.snapshotStatus !== "ready") continue;
      readyChecked += 1;
      const slotInfo = revisionSlot.get(snapshot.characterRevisionId);
      assert.ok(slotInfo, `turn snapshot names a known revision: ${snapshot.characterRevisionId}`);
      assert.equal(
        owners[slotInfo[0]],
        row.owner_scope,
        "turn snapshot revision owner matches the turn owner scope",
      );
      const event = eventByVersion.get(`${row.session_id}:${snapshot.bindingVersion}`);
      assert.ok(event, `snapshot version ${snapshot.bindingVersion} exists in the session's event history`);
      assert.equal(
        event.nextBinding.activeCharacterRevisionId,
        snapshot.characterRevisionId,
        "snapshot revision matches the binding committed at that exact version",
      );
      assert.equal(
        event.nextBinding.compatibilityProfile,
        snapshot.compatibilityProfile,
        "snapshot profile matches the binding committed at that exact version",
      );
    }
    assert.ok(readyChecked > 0, "the stress produced ready character snapshots to verify");
    journal.push(["final", readyChecked, restartCount]);

    // World-book checkpoints: every durable row matches the linearized model —
    // written only by a successful turn, version advanced monotonically from 1,
    // owner/session/book correctly scoped, and rewind purges complete.
    const sessionIndexById = new Map(sessions.map((session, index) => [session.id, index]));
    const checkpointRows = store.db.all(
      `SELECT owner_scope, session_id, world_book_revision_id, version
       FROM world_book_checkpoints`,
    );
    let checkpointsChecked = 0;
    for (const row of checkpointRows) {
      const sessionIdx = sessionIndexById.get(row.session_id);
      assert.ok(sessionIdx !== undefined, `checkpoint row names a known session: ${row.session_id}`);
      assert.equal(
        row.owner_scope,
        owners[sessions[sessionIdx].ownerIdx],
        "checkpoint row owner matches the session owner",
      );
      const slotInfo = bookRevisionSlot.get(row.world_book_revision_id);
      assert.ok(slotInfo, `checkpoint row names a known book revision: ${row.world_book_revision_id}`);
      assert.equal(slotInfo[0], sessions[sessionIdx].ownerIdx, "no cross-owner checkpoint row");
      const model = checkpointModel.get(`${sessionIdx}:${slotInfo[1]}`);
      assert.ok(model, "checkpoint row exists in the linearized model (rewind purges are complete)");
      assert.equal(row.version, model.version, "checkpoint version matches the model");
      assert.ok(row.version >= 1, "checkpoint versions start at 1");
      checkpointsChecked += 1;
    }
    assert.equal(
      checkpointRows.length,
      checkpointModel.size,
      "durable checkpoint rows and the model correspond exactly",
    );
    assert.ok(checkpointsChecked > 0, "the stress produced committed world-book checkpoints to verify");
    journal.push(["final-wb", checkpointsChecked]);

    store.close();
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(journal), "utf8").digest("hex");
    return { journal, fingerprint };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const first = runSimulation();
const second = runSimulation();
assert.equal(
  second.fingerprint,
  first.fingerprint,
  `same seed must reproduce the identical admission fingerprint (${first.fingerprint})`,
);
assert.deepEqual(second.journal, first.journal, "same seed must reproduce the identical op journal");
console.log(`character-worlds-concurrency-stress: ok (${TOTAL_OPS} ops × ${SESSION_COUNT} sessions × 2 seeded runs, fingerprint ${first.fingerprint.slice(0, 16)}…)`);
