"use strict";

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CharacterWorldsRuntime,
  normalizeAdmissionSnapshot,
} = require("../src/main/character-worlds/runtime.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("disabled or absent policy admits a native snapshot", async () => {
    const runtime = new CharacterWorldsRuntime({
      policy: () => ({ enabled: false, reason: "remote_disabled" }),
    });
    const snapshot = runtime.admitTurn({
      ownerScope: "profile:a",
      sessionId: "session-a",
      turnId: "turn-a",
      binding: null,
    });
    assert.equal(snapshot.mode, "native");
    assert.equal(snapshot.ownerScope, "profile:a");
    assert.equal(snapshot.diagnostic.reason, "remote_disabled");
  });

  await check("enabled admission freezes one owner/session/turn snapshot", async () => {
    const runtime = new CharacterWorldsRuntime({
      policy: () => ({ enabled: true, compatibilityProfile: "lily-character-compat-1" }),
    });
    const snapshot = runtime.admitTurn({
      ownerScope: "profile:a",
      sessionId: "session-a",
      turnId: "turn-a",
      binding: {
        mode: "character",
        characterRevisionId: "rev-a",
        personaRevisionId: "persona-a",
        compatibilityProfile: "lily-character-compat-1",
      },
      scene: { id: "scene-a", participantCharacterRevisionIds: [] },
    });
    assert.equal(snapshot.mode, "character");
    assert.equal(snapshot.binding.characterRevisionId, "rev-a");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.binding), true);
    assert.equal(Object.isFrozen(snapshot.scene), true);
    assert.throws(() => { snapshot.binding.characterRevisionId = "rev-b"; }, TypeError);
    assert.equal(snapshot.fingerprint.length, 64);
  });

  await check("invalid scope and malformed binding fail open without leaking input", async () => {
    const runtime = new CharacterWorldsRuntime({
      policy: () => ({ enabled: true }),
    });
    const snapshot = runtime.admitTurn({
      ownerScope: "",
      sessionId: "session-a",
      turnId: "turn-a",
      binding: { mode: "character", characterRevisionId: "rev-a" },
    });
    assert.equal(snapshot.mode, "native");
    assert.equal(snapshot.diagnostic.reason, "owner_invalid");
    assert.equal("secret" in snapshot, false);
  });

  await check("normalization is deterministic and rejects cross-session snapshots", async () => {
    const first = normalizeAdmissionSnapshot({
      mode: "character",
      ownerScope: "profile:a",
      sessionId: "session-a",
      turnId: "turn-a",
      binding: { mode: "character", characterRevisionId: "rev-a" },
    });
    const second = normalizeAdmissionSnapshot(JSON.parse(JSON.stringify(first)));
    assert.deepEqual(first, second);
    assert.throws(() => normalizeAdmissionSnapshot({
      ...first,
      ownerScope: "profile:b",
      binding: { ...first.binding, ownerScope: "profile:a" },
    }), /owner_scope_mismatch/);
  });

  await check("compile delegates through the snapshot and returns native on failure", async () => {
    const seen = [];
    const legacySnapshot = { mode: "character", characterRevisionId: "rev-a", snapshotStatus: "ready" };
    const runtime = new CharacterWorldsRuntime({
      policy: () => ({ enabled: true }),
      compile: ({ snapshot, context }) => {
        seen.push(snapshot.fingerprint);
        assert.equal(context.legacySnapshot, legacySnapshot);
        return { status: "compiled", envelope: { blocks: [] } };
      },
    });
    const snapshot = runtime.admitTurn({
      ownerScope: "profile:a",
      sessionId: "session-a",
      turnId: "turn-a",
      binding: { mode: "character", characterRevisionId: "rev-a" },
    });
    const result = runtime.compileTurn(snapshot, [], { legacySnapshot });
    assert.equal(result.status, "compiled");
    assert.deepEqual(seen, [snapshot.fingerprint]);
  });

  await check("rewind and portability APIs fail closed without unsafe identities", async () => {
    const runtime = new CharacterWorldsRuntime({ repository: null });
    assert.deepEqual(runtime.rewindTo({ sessionId: "s", characterRevisionId: "r", retainedTurnId: "t" }), {
      invalidated: 0,
      reason: "rewind_identity_invalid",
    });
    const exported = runtime.exportScene([{ ownerScope: "profile:a", sessionId: "s" }]);
    assert.equal(typeof exported.json, "string");
    assert.ok(exported.bytes >= 0);
    const imported = await runtime.importScene("profile:a", {});
    assert.equal(imported.ok, true);
  });

  console.log(`PASS: test-character-worlds-runtime (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.stack || error);
  process.exitCode = 1;
}
