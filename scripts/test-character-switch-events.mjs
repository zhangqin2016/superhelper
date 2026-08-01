#!/usr/bin/env node
/**
 * Character Worlds Phase 2B, Task P2B-5: switching timeline events +
 * update-available.
 *
 * Covers (design spec §8):
 *  - Main-side projection: a committed binding change becomes a conversation
 *    notice ("switched to character X" / "returned to native Lily") with the
 *    display name resolved main-side from the pinned revision — never raw
 *    card data. Same-character revision bumps (update applies) and no-op
 *    re-commits stay silent.
 *  - Update-available: main resolves whether the active character/persona has
 *    a newer current revision than the binding's pin, failing open to "no
 *    update" on any resolution hiccup.
 *  - Renderer: notices are binding-version ordered, deduped by bindingVersion
 *    across replays (renderer reload re-reads the durable events), interleave
 *    into the committed timeline by timestamp, render exactly once, and never
 *    inject a greeting/firstMessage into history.
 *  - The session control surfaces "update available" WITHOUT changing the
 *    pinned snapshot; apply re-reads the binding (fresh expectedBindingVersion)
 *    before set-binding; the indicator clears afterwards; a disabled policy
 *    hides the affordance while reads keep working.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  projectBindingSwitchNotices,
  resolveBindingUpdates,
} = require("../src/main/character-worlds/binding-projection.js");

// --- Shared fixtures ---------------------------------------------------------

const REVISIONS = {
  "rev-night-1": { id: "rev-night-1", characterId: "char-night", displayName: "巡夜人", canonical: { name: "巡夜人", description: "RAW CARD DATA" } },
  "rev-night-2": { id: "rev-night-2", characterId: "char-night", displayName: "巡夜人·改", canonical: { name: "巡夜人·改" } },
  "rev-scribe-1": { id: "rev-scribe-1", characterId: "char-scribe", displayName: "抄写员", canonical: { name: "抄写员" } },
};
const resolveRevision = (revisionId) => REVISIONS[revisionId] || null;

function bindingEvent(bindingVersion, previousBinding, nextBinding, createdAt = "") {
  return {
    id: `event-${bindingVersion}`,
    sessionId: "session-a",
    type: "character_binding.changed",
    bindingVersion,
    previousBinding,
    nextBinding,
    createdAt: createdAt || `2026-07-31T08:0${bindingVersion}:00.000Z`,
  };
}
const nativeEnvelope = (bindingVersion) => ({
  bindingVersion, mode: "native", activeCharacterRevisionId: null, activePersonaRevisionId: null,
});
const characterEnvelope = (bindingVersion, revisionId, personaRevisionId = null) => ({
  bindingVersion, mode: "character", activeCharacterRevisionId: revisionId, activePersonaRevisionId: personaRevisionId,
});

// --- Main projection: switch notices -----------------------------------------

{
  const notices = projectBindingSwitchNotices([
    bindingEvent(1, nativeEnvelope(0), characterEnvelope(1, "rev-night-1")),
  ], resolveRevision);
  assert.equal(notices.length, 1, "native → character produces one notice");
  assert.equal(notices[0].mode, "character");
  assert.equal(notices[0].characterName, "巡夜人", "display name resolved main-side from the revision");
  assert.equal(notices[0].bindingVersion, 1);
  // Whitelisted fields only — raw card data (canonical, description, …) never
  // crosses into the notice payload.
  assert.deepEqual(
    Object.keys(notices[0]).sort(),
    ["bindingVersion", "characterName", "createdAt", "mode"],
    "notice carries only whitelisted fields",
  );
  assert(!JSON.stringify(notices[0]).includes("RAW CARD DATA"), "no raw card data in the notice");
}

{
  const notices = projectBindingSwitchNotices([
    bindingEvent(2, characterEnvelope(1, "rev-night-1"), nativeEnvelope(2)),
  ], resolveRevision);
  assert.equal(notices.length, 1, "character → native produces one notice");
  assert.equal(notices[0].mode, "native");
  assert.equal(notices[0].characterName, "", "a native switch carries no name");
}

{
  const notices = projectBindingSwitchNotices([
    bindingEvent(1, nativeEnvelope(0), characterEnvelope(1, "rev-night-1")),
    bindingEvent(2, characterEnvelope(1, "rev-night-1"), characterEnvelope(2, "rev-scribe-1")),
    bindingEvent(3, characterEnvelope(2, "rev-scribe-1"), nativeEnvelope(3)),
  ], resolveRevision);
  assert.deepEqual(notices.map((n) => n.bindingVersion), [1, 2, 3], "notices stay binding-version ordered");
  assert.deepEqual(notices.map((n) => n.mode), ["character", "character", "native"]);
  assert.equal(notices[1].characterName, "抄写员", "switching between characters resolves the new name");
}

{
  // Same-character revision bump (an update-available apply) is NOT a switch.
  const notices = projectBindingSwitchNotices([
    bindingEvent(2, characterEnvelope(1, "rev-night-1"), characterEnvelope(2, "rev-night-2")),
  ], resolveRevision);
  assert.equal(notices.length, 0, "same-character revision bump stays silent");
}

{
  // No-op re-commits and native → native stay silent.
  const notices = projectBindingSwitchNotices([
    bindingEvent(1, characterEnvelope(0, "rev-night-1"), characterEnvelope(1, "rev-night-1")),
    bindingEvent(2, nativeEnvelope(1), nativeEnvelope(2)),
  ], resolveRevision);
  assert.equal(notices.length, 0, "no-op re-commits produce no notice");
}

{
  // Fail open: an unreadable pinned revision still reports the switch, with an
  // empty name for the renderer to localize — never a thrown read.
  const notices = projectBindingSwitchNotices([
    bindingEvent(1, nativeEnvelope(0), characterEnvelope(1, "rev-missing")),
  ], resolveRevision);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].characterName, "", "missing revision fails open with no name");
}

{
  assert.deepEqual(projectBindingSwitchNotices([], resolveRevision), []);
  assert.deepEqual(projectBindingSwitchNotices(null, resolveRevision), [], "null events fail open");
  assert.deepEqual(
    projectBindingSwitchNotices([{ id: "corrupt" }], resolveRevision),
    [],
    "corrupt events are skipped",
  );
}

// --- Main projection: update-available ---------------------------------------

function fakeRepo({ characters = {}, personas = {}, revisions = REVISIONS, personaRevisions = {} } = {}) {
  return {
    getRevision: (owner, revisionId) => revisions[revisionId] || null,
    getCharacter: (owner, characterId) => characters[characterId] || null,
    getPersonaRevision: (owner, revisionId) => personaRevisions[revisionId] || null,
    getPersona: (owner, personaId) => personas[personaId] || null,
  };
}

{
  const repo = fakeRepo({
    characters: { "char-night": { id: "char-night", currentRevisionId: "rev-night-2" } },
  });
  const updates = resolveBindingUpdates(repo, "owner", {
    mode: "character", characterRevisionId: "rev-night-1", personaRevisionId: null,
  });
  assert.deepEqual(updates, { character: { currentRevisionId: "rev-night-2" } },
    "newer current revision than the pin surfaces an update");
  // The binding pin itself is an input, never mutated.
}

{
  const repo = fakeRepo({
    characters: { "char-night": { id: "char-night", currentRevisionId: "rev-night-1" } },
    personaRevisions: { "persona-rev-1": { id: "persona-rev-1", personaId: "persona-a", name: "设定A" } },
    personas: { "persona-a": { id: "persona-a", currentRevisionId: "persona-rev-2" } },
  });
  const updates = resolveBindingUpdates(repo, "owner", {
    mode: "character", characterRevisionId: "rev-night-1", personaRevisionId: "persona-rev-1",
  });
  assert.deepEqual(updates, { persona: { currentRevisionId: "persona-rev-2" } },
    "a newer persona revision surfaces independently of the character");
}

{
  const repo = fakeRepo({
    characters: { "char-night": { id: "char-night", currentRevisionId: "rev-night-1" } },
  });
  const updates = resolveBindingUpdates(repo, "owner", {
    mode: "character", characterRevisionId: "rev-night-1", personaRevisionId: null,
  });
  assert.equal(updates, null, "pinned == current means no update");
}

{
  const repo = fakeRepo();
  assert.equal(resolveBindingUpdates(repo, "owner", { mode: "native", characterRevisionId: null }), null,
    "native binding never has updates");
  assert.equal(resolveBindingUpdates(repo, "owner", {
    mode: "character", characterRevisionId: "rev-night-1", personaRevisionId: null,
  }), null, "missing entity/revision fails open to no update");
  const throwing = {
    getRevision() { throw new Error("db gone"); },
  };
  assert.equal(resolveBindingUpdates(throwing, "owner", {
    mode: "character", characterRevisionId: "rev-night-1", personaRevisionId: null,
  }), null, "a resolution failure fails open, never breaks the read");
}

// --- Renderer: runtime store notices ------------------------------------------

const store = await import("../src/renderer/modules/session-runtime-store.js");
const switchNotices = await import("../src/renderer/modules/character-switch-notices.js");
const renderModel = await import("../src/renderer/modules/message-committed-render-model.js");
const renderKeys = await import("../src/renderer/modules/message-render-keys.js");
const { applyCharacterSwitchNotices } = switchNotices;

const SWITCH_EVENTS = [
  bindingEvent(1, nativeEnvelope(0), characterEnvelope(1, "rev-night-1")),
  bindingEvent(2, characterEnvelope(1, "rev-night-1"), characterEnvelope(2, "rev-scribe-1")),
  bindingEvent(3, characterEnvelope(2, "rev-scribe-1"), nativeEnvelope(3)),
];
const SWITCH_NOTICES = projectBindingSwitchNotices(SWITCH_EVENTS, resolveRevision);
assert.equal(SWITCH_NOTICES.length, 3, "fixture sanity: three switch notices");

{
  applyCharacterSwitchNotices("sw-a", SWITCH_NOTICES);
  let runtime = store.getRuntimeSession("sw-a");
  assert.deepEqual(runtime.switchNotices.map((n) => n.bindingVersion), [1, 2, 3],
    "notices are binding-version ordered");

  // Renderer reload: replaying the SAME durable events adds nothing twice.
  applyCharacterSwitchNotices("sw-a", SWITCH_NOTICES);
  runtime = store.getRuntimeSession("sw-a");
  assert.equal(runtime.switchNotices.length, 3, "replay dedupes by bindingVersion");

  // Rapid successive switches: incremental after-version fetches merge with no
  // duplicates and no lost versions, even if a page repeats an overlap.
  applyCharacterSwitchNotices("sw-rapid", SWITCH_NOTICES.slice(0, 1));
  applyCharacterSwitchNotices("sw-rapid", SWITCH_NOTICES.slice(0, 2));
  applyCharacterSwitchNotices("sw-rapid", SWITCH_NOTICES.slice(1));
  applyCharacterSwitchNotices("sw-rapid", SWITCH_NOTICES);
  runtime = store.getRuntimeSession("sw-rapid");
  assert.deepEqual(runtime.switchNotices.map((n) => n.bindingVersion), [1, 2, 3],
    "rapid switches: ordered, deduped, none lost");
  assert.deepEqual(runtime.switchNotices.map((n) => n.characterName), ["巡夜人", "抄写员", ""]);

  // No greeting injection: applying switch notices never touches the committed
  // history — no assistant message, no firstMessage, nothing.
  runtime = store.getRuntimeSession("sw-a");
  assert.equal(runtime.committedMessages.length, 0, "switching never injects messages");
  assert(!runtime.committedMessages.some((m) => m.role === "assistant"),
    "no greeting/firstMessage is ever injected");

  // Garbage in: corrupt notice entries are skipped, never stored.
  applyCharacterSwitchNotices("sw-garbage", [
    { bindingVersion: "x", mode: "character" },
    null,
    { bindingVersion: 0, mode: "native" },
    { bindingVersion: 4, mode: "character", characterName: 42 },
  ]);
  runtime = store.getRuntimeSession("sw-garbage");
  assert.equal(runtime.switchNotices.length, 1, "only the valid notice lands");
  assert.equal(runtime.switchNotices[0].characterName, "42", "names are string-coerced defensively");
}

// --- Renderer: notices window cap ----------------------------------------------

{
  // The per-session notices list is capped at SWITCH_NOTICE_LIMIT newest by
  // bindingVersion; older notices are evicted (they would be outside the
  // committed render window anyway) and the cursor keeps advancing.
  const many = [];
  for (let v = 1; v <= 250; v += 1) {
    many.push({ bindingVersion: v, mode: "character", characterName: `角色${v}`, createdAt: "" });
  }
  applyCharacterSwitchNotices("sw-cap", many);
  const runtime = store.getRuntimeSession("sw-cap");
  assert.equal(runtime.switchNotices.length, 200, "notices window is capped");
  assert.equal(runtime.switchNotices[0].bindingVersion, 51, "oldest versions are evicted");
  assert.equal(runtime.switchNotices.at(-1).bindingVersion, 250, "newest version survives");
  assert.deepEqual(
    runtime.switchNotices.map((n) => n.bindingVersion),
    Array.from({ length: 200 }, (_, i) => i + 51),
    "the capped window stays binding-version ordered",
  );
  // A replay of evicted versions must not resurrect them outside the cap.
  applyCharacterSwitchNotices("sw-cap", many.slice(0, 10));
  assert.equal(store.getRuntimeSession("sw-cap").switchNotices.length, 200,
    "evicted versions stay evicted on replay");
  // mergeSwitchNotices still interleaves the capped window correctly.
  const merged = renderModel.orderCommittedMessages(renderModel.mergeSwitchNotices(
    [{ id: "u1", role: "user", turnId: "t1", content: "q", timestamp: "2026-07-31T08:00:00.000Z" }],
    store.getRuntimeSession("sw-cap").switchNotices.slice(-2),
  ));
  assert.deepEqual(merged.map((m) => m.role), ["user", "notice", "notice"]);
}

// --- Renderer: notice fetch pagination (200-event repository page) -------------
// repository.getBindingEvents returns binding_version ASC LIMIT 200 — without
// an afterVersion cursor the renderer would forever re-read the FIRST page and
// switches beyond version 200 would never appear.

{
  const { createSwitchNoticeLoader } = await import("../src/renderer/modules/character-binding-updates.js");

  // A session with 250 committed binding events; switches at 150, 249, 250,
  // and non-switch revision bumps elsewhere. The fake facade emulates the
  // repository page semantics (ASC, > afterVersion, LIMIT 200).
  const allEvents = [];
  for (let v = 1; v <= 250; v += 1) {
    const prev = v === 1 ? nativeEnvelope(0) : characterEnvelope(v - 1, "rev-night-1");
    allEvents.push(bindingEvent(v, prev, characterEnvelope(v, "rev-night-1")));
  }
  allEvents[149] = bindingEvent(150, characterEnvelope(149, "rev-night-1"), characterEnvelope(150, "rev-scribe-1"));
  allEvents[248] = bindingEvent(249, characterEnvelope(248, "rev-scribe-1"), nativeEnvelope(249));
  allEvents[249] = bindingEvent(250, nativeEnvelope(249), characterEnvelope(250, "rev-night-1"));
  const fetchLog = [];
  const fakeFacade = {
    getSessionCharacterEvents: async (sessionId, options = {}) => {
      const afterVersion = Number(options.afterVersion) || 0;
      fetchLog.push(afterVersion);
      const events = allEvents.filter((e) => e.bindingVersion > afterVersion).slice(0, 200);
      return { ok: true, events, notices: projectBindingSwitchNotices(events, resolveRevision) };
    },
  };
  const controlState = { sessionId: "sw-paged", bindingVersion: 250 };
  const loadSwitchNotices = createSwitchNoticeLoader({
    getState: () => controlState,
    getFacade: () => fakeFacade,
  });

  // First load seeds from the recent tail: bindingVersion 250 − window 200.
  await loadSwitchNotices("sw-paged");
  assert.deepEqual(fetchLog, [50], "first load fetches the recent tail, not the first page");
  let notices = store.getRuntimeSession("sw-paged").switchNotices;
  assert.deepEqual(notices.map((n) => n.bindingVersion), [150, 249, 250],
    "tail page projects the switches inside the window");

  // A new switch beyond the 200-event cap: the next fetch continues from the
  // cursor (max seen EVENT version), so it arrives even though the repository
  // would otherwise keep returning the same first page.
  allEvents.push(bindingEvent(251, characterEnvelope(250, "rev-night-1"), characterEnvelope(251, "rev-scribe-1")));
  controlState.bindingVersion = 251;
  await loadSwitchNotices("sw-paged");
  assert.deepEqual(fetchLog, [50, 250], "subsequent fetches pass afterVersion = max seen version");
  notices = store.getRuntimeSession("sw-paged").switchNotices;
  assert.deepEqual(notices.map((n) => n.bindingVersion), [150, 249, 250, 251],
    "a switch beyond the 200-event page still appears");

  // Exactly-once replay: re-running the same fetch adds nothing.
  await loadSwitchNotices("sw-paged");
  notices = store.getRuntimeSession("sw-paged").switchNotices;
  assert.deepEqual(notices.map((n) => n.bindingVersion), [150, 249, 250, 251],
    "replay dedupes by bindingVersion");

  // Cursor tracks EVENTS, not just notices: a page of non-switch events must
  // still advance the cursor, or a long run of revision bumps would re-fetch
  // the same page forever and hide the next switch.
  const quietFacadeLog = [];
  const quietEvents = [];
  for (let v = 101; v <= 320; v += 1) {
    quietEvents.push(bindingEvent(v, characterEnvelope(v - 1, "rev-night-1"), characterEnvelope(v, "rev-night-1")));
  }
  quietEvents.push(bindingEvent(321, characterEnvelope(320, "rev-night-1"), characterEnvelope(321, "rev-scribe-1")));
  const quietFacade = {
    getSessionCharacterEvents: async (sessionId, options = {}) => {
      const afterVersion = Number(options.afterVersion) || 0;
      quietFacadeLog.push(afterVersion);
      const events = quietEvents.filter((e) => e.bindingVersion > afterVersion).slice(0, 200);
      return { ok: true, events, notices: projectBindingSwitchNotices(events, resolveRevision) };
    },
  };
  const quietState = { sessionId: "sw-quiet", bindingVersion: 320 };
  const loadQuiet = createSwitchNoticeLoader({ getState: () => quietState, getFacade: () => quietFacade });
  await loadQuiet("sw-quiet"); // tail seed: afterVersion 120 → events 121..320, all non-switch
  assert.deepEqual(quietFacadeLog, [120]);
  assert.equal(store.getRuntimeSession("sw-quiet").switchNotices.length, 0, "no switches in the page");
  await loadQuiet("sw-quiet"); // cursor advanced past the quiet page
  assert.deepEqual(quietFacadeLog, [120, 320], "a notice-free page still advances the cursor");
  assert.deepEqual(
    store.getRuntimeSession("sw-quiet").switchNotices.map((n) => n.bindingVersion),
    [321],
    "the switch behind a quiet page is found",
  );
}

// --- Renderer: committed-timeline interleave -----------------------------------

{
  const committed = [
    { id: "u1", role: "user", turnId: "t1", content: "q1", timestamp: "2026-07-31T08:00:30.000Z" },
    { id: "a1", role: "assistant", turnId: "t1", content: "r1", timestamp: "2026-07-31T08:00:45.000Z" },
    { id: "u2", role: "user", turnId: "t2", content: "q2", timestamp: "2026-07-31T08:02:30.000Z" },
  ];
  const notices = [
    { bindingVersion: 1, mode: "character", characterName: "巡夜人", ts: Date.parse("2026-07-31T08:01:00.000Z") },
    { bindingVersion: 2, mode: "native", characterName: "", ts: Date.parse("2026-07-31T08:03:00.000Z") },
  ];
  const merged = renderModel.orderCommittedMessages(renderModel.mergeSwitchNotices(committed, notices));
  assert.deepEqual(merged.map((m) => m.role), ["user", "assistant", "notice", "user", "notice"],
    "switch notices interleave into the committed timeline by timestamp");

  // Keyed render bookkeeping: the same merged list rendered twice yields each
  // notice exactly once (stable id-based key).
  const keys = new Set();
  const firstPass = renderKeys.collectUnrenderedCommittedMessages(merged, keys);
  assert.equal(firstPass.filter(({ message }) => message.role === "notice").length, 2);
  const secondPass = renderKeys.collectUnrenderedCommittedMessages(merged, keys);
  assert.equal(secondPass.length, 0, "re-render adds nothing twice — notices appear exactly once");

  // No notices → the committed array passes through untouched.
  assert.equal(renderModel.mergeSwitchNotices(committed, []), committed);
  assert.equal(renderModel.mergeSwitchNotices(committed, null), committed);
}

// --- Renderer: control model update-available -----------------------------------

const control = await import("../src/renderer/modules/character-session-control.js");
const {
  initialCharacterControlState,
  reduceCharacterControl,
  effectiveBindingUpdates,
} = control;

{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed", sessionId: "session-a",
  });
  state = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "session-a",
    seq: state.loadSeq,
    binding: { mode: "character", bindingVersion: 5, characterRevisionId: "rev-night-1" },
    updates: { character: { currentRevisionId: "rev-night-2" } },
  });
  assert.deepEqual(effectiveBindingUpdates(state), { character: { currentRevisionId: "rev-night-2" } },
    "an available update surfaces in the control");
  // Surfacing the affordance must NOT change the pinned snapshot.
  assert.equal(state.characterRevisionId, "rev-night-1", "pinned revision unchanged by the update hint");
  assert.equal(state.bindingVersion, 5, "pinned binding version unchanged by the update hint");

  // Policy disabled (kill switch): the affordance hides while the read state
  // (binding, characters) stays intact.
  const disabled = reduceCharacterControl(state, { type: "availability.set", available: false });
  assert.equal(effectiveBindingUpdates(disabled), null, "policy disabled → update-available hidden/inert");
  assert.equal(disabled.characterRevisionId, "rev-night-1", "reads still work under a disabled policy");
  const reenabled = reduceCharacterControl(disabled, { type: "availability.set", available: true });
  assert.deepEqual(effectiveBindingUpdates(reenabled), { character: { currentRevisionId: "rev-night-2" } },
    "the hint returns when the policy recovers");

  // Applying (or any successful selection settle) clears the indicator.
  const applied = reduceCharacterControl(state, {
    type: "selection.settled",
    sessionId: "session-a",
    seq: state.loadSeq,
    binding: { mode: "character", bindingVersion: 6, characterRevisionId: "rev-night-2" },
  });
  assert.equal(effectiveBindingUpdates(applied), null, "indicator clears after apply");

  // A CAS conflict reconcile drops the stale hint (a fresh load repopulates).
  const conflicted = reduceCharacterControl(state, {
    type: "binding.conflict",
    sessionId: "session-a",
    seq: state.loadSeq,
    currentBinding: { mode: "character", bindingVersion: 7, characterRevisionId: "rev-night-2" },
  });
  assert.equal(effectiveBindingUpdates(conflicted), null, "conflict reconcile clears the stale hint");

  // Malformed update hints fail open to nothing.
  const malformed = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "session-a",
    binding: { mode: "character", bindingVersion: 1, characterRevisionId: "rev-night-1" },
    updates: { character: { currentRevisionId: 42 }, persona: "bogus" },
  });
  assert.equal(effectiveBindingUpdates(malformed), null, "malformed updates are dropped");

  // Apply in-flight guard: updateapply.started holds `selecting` — which also
  // blocks selectMode (the reverse race) — without optimistically repinning.
  const applying = reduceCharacterControl(state, {
    type: "updateapply.started", sessionId: "session-a", seq: state.loadSeq,
  });
  assert.equal(applying.selecting, true, "apply holds the selecting guard while in flight");
  assert.equal(applying.characterRevisionId, "rev-night-1", "apply does not optimistically change the pin");
  const staleStart = reduceCharacterControl(state, {
    type: "updateapply.started", sessionId: "session-a", seq: state.loadSeq + 99,
  });
  assert.equal(staleStart.selecting, false, "stale guard actions are dropped");
  const applyDone = reduceCharacterControl(applying, {
    type: "updateapply.finished", sessionId: "session-a", seq: state.loadSeq,
  });
  assert.equal(applyDone.selecting, false, "the guard releases");
  const settleReleases = reduceCharacterControl(applying, {
    type: "selection.settled",
    sessionId: "session-a",
    seq: state.loadSeq,
    binding: { mode: "character", bindingVersion: 6, characterRevisionId: "rev-night-2" },
  });
  assert.equal(settleReleases.selecting, false, "a settle releases the guard");
}

// --- Controller: apply flow uses a FRESH expectedBindingVersion -----------------
// The controller module reads window.assistantClient + document; in node both
// are minimal stubs so the DOM renders are inert no-ops and only the facade
// calls + reducer transitions run.

{
  const setCalls = [];
  let getBindingReads = 0;
  // Server-side truth: an update is available until the apply commits, after
  // which the entity's current revision equals the pin and the hint clears.
  let serverUpdates = { character: { currentRevisionId: "rev-night-2" } };
  // The server moved on while the popover was open: the control's known
  // version (5) is stale; the fresh read reports 7, then 8 after the apply.
  let serverBinding = { mode: "character", bindingVersion: 7, characterRevisionId: "rev-night-1", personaRevisionId: null };
  const fakeFacade = {
    listCharacters: async () => ({ ok: true, characters: [] }),
    getSessionCharacterBinding: async () => {
      getBindingReads += 1;
      return { ok: true, binding: serverBinding, updates: serverUpdates };
    },
    setSessionCharacterBinding: async (payload) => {
      setCalls.push(payload);
      serverUpdates = null;
      serverBinding = {
        mode: "character",
        bindingVersion: serverBinding.bindingVersion + 1,
        characterRevisionId: payload.characterRevisionId,
        personaRevisionId: payload.personaRevisionId || null,
      };
      return { ok: true, binding: serverBinding };
    },
    getSessionCharacterEvents: async () => ({
      ok: true,
      events: [],
      notices: [{ bindingVersion: 8, mode: "character", characterName: "", createdAt: "2026-07-31T09:00:00.000Z" }],
    }),
  };
  globalThis.window = { assistantClient: { characterWorlds: fakeFacade } };
  globalThis.document = {
    getElementById: () => null,
    addEventListener: () => {},
    activeElement: null,
  };

  control.dispatchCharacterControl({ type: "session.changed", sessionId: "session-apply" });
  let state = control.getCharacterControlState();
  control.dispatchCharacterControl({
    type: "binding.loaded",
    sessionId: "session-apply",
    seq: state.loadSeq,
    binding: { mode: "character", bindingVersion: 5, characterRevisionId: "rev-night-1" },
    updates: { character: { currentRevisionId: "rev-night-2" } },
  });

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await control.applyBindingUpdates();
  await flush(); // the settle triggers fire-and-forget binding/notice refreshes
  assert.equal(setCalls.length, 1, "apply issues exactly one set-binding");
  assert.equal(setCalls[0].expectedBindingVersion, 7,
    "apply uses the CURRENT expectedBindingVersion from a fresh read, not the stale 5");
  assert.equal(setCalls[0].mode, "character");
  assert.equal(setCalls[0].characterRevisionId, "rev-night-2", "apply pins the current revision");
  assert(getBindingReads >= 2, "apply re-reads the binding before writing");

  state = control.getCharacterControlState();
  assert.equal(effectiveBindingUpdates(state), null, "indicator clears after a successful apply");
  assert.equal(state.bindingVersion, 8, "control tracks the new committed version");

  const runtime = store.getRuntimeSession("session-apply");
  // The post-apply refresh pulled the durable events; the revision bump is not
  // a switch, but the projection channel was exercised (here the mock returns
  // one) — the point is the refresh happens and dedups by version.
  assert.equal(runtime.switchNotices.length, 1, "settle refreshes the switch notices");
  await control.applyBindingUpdates();
  await flush();
  assert.equal(runtime.switchNotices.length, 1, "repeated refresh never duplicates notices");

  // Policy disabled → apply is inert (no write), reads untouched.
  const callsBefore = setCalls.length;
  control.dispatchCharacterControl({ type: "availability.set", available: false });
  await control.applyBindingUpdates();
  await flush();
  assert.equal(setCalls.length, callsBefore, "policy disabled → no set-binding write");
  control.dispatchCharacterControl({ type: "availability.set", available: true });

  // Double-click: the in-flight guard (selecting) makes the second click a
  // no-op — exactly one commit, no bogus conflict notice, guard released.
  serverUpdates = { character: { currentRevisionId: "rev-night-3" } };
  control.dispatchCharacterControl({
    type: "binding.loaded",
    sessionId: "session-apply",
    seq: control.getCharacterControlState().loadSeq,
    binding: serverBinding,
    updates: serverUpdates,
  });
  await Promise.all([control.applyBindingUpdates(), control.applyBindingUpdates()]);
  await flush();
  assert.equal(setCalls.length, callsBefore + 1, "double-click commits exactly once");
  assert.equal(setCalls.at(-1).characterRevisionId, "rev-night-3", "the single commit pins the current revision");
  state = control.getCharacterControlState();
  assert.equal(state.selecting, false, "the in-flight guard is released after settle");
  assert.notEqual(state.notice, "conflict", "no bogus conflict notice from the second click");
  assert.equal(state.bindingVersion, 9, "the single commit advanced the version once");

  // Apply button is disabled while an apply/selection is in flight.
  {
    const { renderBindingUpdateRow } = await import("../src/renderer/modules/character-binding-updates.js");
    globalThis.document = {
      createElement: (tag) => ({
        tag,
        className: "",
        textContent: "",
        disabled: false,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener() {},
      }),
    };
    const row = { hidden: true, textContent: "x", kids: [], appendChild(c) { this.kids.push(c); } };
    renderBindingUpdateRow(row, {
      available: true,
      selecting: true,
      updates: { character: { currentRevisionId: "rev-night-4" } },
    });
    const applyButton = row.kids.find((kid) => kid.attrs?.["data-action"] === "apply-update");
    assert(applyButton, "apply button renders while the hint is visible");
    assert.equal(applyButton.disabled, true, "apply button disabled while in flight");
    const idleRow = { hidden: true, textContent: "x", kids: [], appendChild(c) { this.kids.push(c); } };
    renderBindingUpdateRow(idleRow, {
      available: true,
      selecting: false,
      updates: { character: { currentRevisionId: "rev-night-4" } },
    });
    const idleButton = idleRow.kids.find((kid) => kid.attrs?.["data-action"] === "apply-update");
    assert.equal(idleButton.disabled, false, "apply button enabled when idle");
  }

  delete globalThis.window;
  delete globalThis.document;
}

console.log("character-switch-events: ok");
