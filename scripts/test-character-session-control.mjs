#!/usr/bin/env node
/**
 * Pure reducer tests for the conversation-level character control
 * (Character Worlds Phase 1, plan Task 9 step 1).
 *
 * The reducer is pure and session-scoped: it never touches IPC, DOM, or
 * timers, and stale async responses (wrong sessionId or superseded seq) are
 * dropped so rapid session switching can never cross-bind a conversation.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  initialCharacterControlState,
  reduceCharacterControl,
  effectiveCharacterMode,
} = await import("../src/renderer/modules/character-session-control.js");
const { createRoleBannerRenderer } = await import("../src/renderer/modules/character-binding-updates.js");

const characterBinding = {
  mode: "character",
  bindingVersion: 2,
  characterRevisionId: "rev-a",
  compatibilityProfile: "lily-character-compat-1",
};

// --- Plan step 1 example, verbatim -----------------------------------------
{
  const state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "session-a",
    binding: { mode: "character", bindingVersion: 2, characterRevisionId: "rev-a", personaRevisionId: "persona-a" },
  });
  assert.equal(state.mode, "character");
  assert.equal(state.personaRevisionId, "persona-a", "persona pin surfaces for the §13.1 indicator");

  const conflicted = reduceCharacterControl(state, {
    type: "binding.conflict",
    currentBinding: { mode: "native", bindingVersion: 3 },
  });
  assert.equal(conflicted.mode, "native");
  assert.equal(conflicted.bindingVersion, 3);
}

// --- Purity: the reducer never mutates its input ----------------------------
{
  const before = initialCharacterControlState();
  const frozen = JSON.parse(JSON.stringify(before));
  reduceCharacterControl(before, {
    type: "binding.loaded",
    sessionId: "s1",
    binding: characterBinding,
  });
  assert.deepEqual(before, frozen, "reducer must not mutate the previous state");
}

// --- Native mode -------------------------------------------------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: characterBinding,
  });
  state = reduceCharacterControl(state, {
    type: "selection.started",
    mode: "native",
  });
  assert.equal(state.mode, "native");
  assert.equal(state.characterRevisionId, null);
  assert.equal(state.selecting, true);
  state = reduceCharacterControl(state, {
    type: "selection.settled",
    binding: { mode: "native", bindingVersion: 3, characterRevisionId: null },
  });
  assert.equal(state.selecting, false);
  assert.equal(state.bindingVersion, 3);
}

// --- Stale async responses: wrong sessionId is dropped ----------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "session-b",
  });
  const stale = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "session-a",
    binding: characterBinding,
  });
  assert.equal(stale.mode, "native", "a binding for another session must not apply");
  assert.equal(stale.characterRevisionId, null);
  state = stale;
  const fresh = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "session-b",
    binding: characterBinding,
  });
  assert.equal(fresh.mode, "character");
}

// --- Stale async responses: superseded seq is dropped ------------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "s1",
  });
  const firstSeq = state.loadSeq;
  state = reduceCharacterControl(state, { type: "session.changed", sessionId: "s1" });
  assert.ok(state.loadSeq > firstSeq, "session.changed must invalidate in-flight loads");
  const stale = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "s1",
    seq: firstSeq,
    binding: characterBinding,
  });
  assert.equal(stale.mode, "native", "a superseded load must not apply");
  const fresh = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "s1",
    seq: state.loadSeq,
    binding: characterBinding,
  });
  assert.equal(fresh.mode, "character");
}

// --- Rapid session switching: last switch wins, no cross-binding ------------
{
  let state = initialCharacterControlState();
  const seqs = {};
  for (const sid of ["a", "b", "a"]) {
    state = reduceCharacterControl(state, { type: "session.changed", sessionId: sid });
    seqs[`${sid}:${state.loadSeq}`] = state.loadSeq;
  }
  const finalSeq = state.loadSeq;
  // Responses arrive out of order: slow "b" load, then slow earlier "a" load,
  // then the load for the final switch.
  state = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "b",
    binding: { mode: "character", bindingVersion: 9, characterRevisionId: "rev-b" },
  });
  state = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "a",
    seq: finalSeq - 2,
    binding: { mode: "character", bindingVersion: 8, characterRevisionId: "rev-old-a" },
  });
  assert.equal(state.mode, "native", "stale responses during rapid switching must be dropped");
  state = reduceCharacterControl(state, {
    type: "binding.loaded",
    sessionId: "a",
    seq: finalSeq,
    binding: { mode: "character", bindingVersion: 4, characterRevisionId: "rev-a" },
  });
  assert.equal(state.mode, "character");
  assert.equal(state.characterRevisionId, "rev-a");
  assert.equal(state.sessionId, "a");
}

// --- Corrupt bound card fails open to native with a quiet notice ------------
{
  const state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: { mode: "character", bindingVersion: 5, characterRevisionId: null },
  });
  assert.equal(state.mode, "native", "a corrupt binding must display as native Lily");
  assert.equal(state.notice, "binding_fallback");
  assert.equal(state.bindingVersion, 5, "the binding version is preserved for recovery");
}

// --- Malformed binding payload fails open ------------------------------------
{
  const state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: null,
  });
  assert.equal(state.mode, "native");
  assert.equal(effectiveCharacterMode(state), "native");
}

// --- Switching mid-turn stays consistent (admission safety is main-side) ----
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: characterBinding,
  });
  state = reduceCharacterControl(state, {
    type: "selection.started",
    mode: "character",
    characterRevisionId: "rev-b",
    characterName: "旁白",
  });
  assert.equal(state.mode, "character");
  assert.equal(state.characterRevisionId, "rev-b");
  state = reduceCharacterControl(state, {
    type: "selection.settled",
    sessionId: "s1",
    binding: { mode: "character", bindingVersion: 3, characterRevisionId: "rev-b" },
  });
  assert.equal(state.selecting, false);
  assert.equal(state.bindingVersion, 3);
}

// --- First-use official install keeps its visible name after binding --------
{
  let state = initialCharacterControlState({
    sessionId: "s-official",
    characters: [{
      id: "official:lily-companion",
      officialId: "lily-companion",
      official: true,
      displayName: "Lily · 深度陪伴者",
    }],
  });
  state = reduceCharacterControl(state, {
    type: "selection.started",
    mode: "character",
    characterRevisionId: null,
    characterName: "Lily · 深度陪伴者",
  });
  state = reduceCharacterControl(state, {
    type: "selection.settled",
    sessionId: "s-official",
    seq: 0,
    characterName: "Lily · 深度陪伴者",
    binding: { mode: "character", bindingVersion: 1, characterRevisionId: "rev-official" },
  });
  assert.equal(state.characterName, "Lily · 深度陪伴者");
}

// --- Stale selection outcomes are dropped ------------------------------------
{
  // A selection started in session A must never land on session B.
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "session-a",
  });
  const seqA = state.loadSeq;
  state = reduceCharacterControl(state, {
    type: "selection.started",
    mode: "character",
    characterRevisionId: "rev-a",
    characterName: "甲",
  });
  state = reduceCharacterControl(state, { type: "session.changed", sessionId: "session-b" });
  assert.equal(state.mode, "native");

  const afterSettle = reduceCharacterControl(state, {
    type: "selection.settled",
    sessionId: "session-a",
    seq: seqA,
    binding: { mode: "character", bindingVersion: 2, characterRevisionId: "rev-a" },
  });
  assert.equal(afterSettle.mode, "native", "stale settle must not apply to the new session");
  assert.equal(afterSettle.characterRevisionId, null);

  const afterConflict = reduceCharacterControl(state, {
    type: "binding.conflict",
    sessionId: "session-a",
    seq: seqA,
    currentBinding: { mode: "character", bindingVersion: 7, characterRevisionId: "rev-a" },
  });
  assert.equal(afterConflict.mode, "native", "stale conflict must not apply to the new session");
  assert.equal(afterConflict.notice, null);

  const afterFailure = reduceCharacterControl(state, {
    type: "selection.failed",
    sessionId: "session-a",
    seq: seqA,
  });
  assert.equal(afterFailure.notice, null, "stale failure must not announce into the new session");

  // A current (matching) outcome still applies.
  const current = reduceCharacterControl(state, {
    type: "selection.settled",
    sessionId: "session-b",
    seq: state.loadSeq,
    binding: { mode: "character", bindingVersion: 1, characterRevisionId: "rev-b" },
  });
  assert.equal(current.mode, "character");
  assert.equal(current.characterRevisionId, "rev-b");
}

// --- Load failure: transient keeps state, unavailable returns view to native --
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: characterBinding,
  });
  const transient = reduceCharacterControl(state, {
    type: "binding.loadFailed",
    sessionId: "s1",
    seq: state.loadSeq,
  });
  assert.equal(transient.mode, "character", "a transient failure keeps the last known binding");
  assert.equal(effectiveCharacterMode(transient), "character");

  const killed = reduceCharacterControl(state, {
    type: "binding.loadFailed",
    sessionId: "s1",
    seq: state.loadSeq,
    error: "CHARACTER_WORLDS_UNAVAILABLE",
  });
  assert.equal(killed.mode, "character", "the stored binding survives a kill switch");
  assert.equal(killed.available, false);
  assert.equal(effectiveCharacterMode(killed), "native", "the view returns to native Lily");
  assert.equal(killed.notice, "unavailable");
}

// --- Final-boundary application evidence is scoped to session + revision -----
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: characterBinding,
  });
  state = reduceCharacterControl(state, {
    type: "application.updated",
    sessionId: "s1",
    application: { status: "applied", revisionId: characterBinding.characterRevisionId, expressionProfile: "balanced" },
  });
  assert.equal(state.application.status, "applied");
  const staleSession = reduceCharacterControl(state, {
    type: "application.updated",
    sessionId: "s2",
    application: { status: "bypassed", revisionId: characterBinding.characterRevisionId },
  });
  assert.equal(staleSession, state);
  const staleRevision = reduceCharacterControl(state, {
    type: "application.updated",
    sessionId: "s1",
    application: { status: "bypassed", revisionId: "rev-other" },
  });
  assert.equal(staleRevision, state);
  state = reduceCharacterControl(state, {
    type: "application.updated",
    sessionId: "s1",
    application: null,
  });
  assert.equal(state.application, null, "a new turn clears the previous turn's applied receipt");
}

// --- Active session going away resets the control -----------------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: characterBinding,
  });
  state = reduceCharacterControl(state, { type: "session.changed", sessionId: null });
  assert.equal(state.sessionId, null);
  assert.equal(state.mode, "native");
  assert.equal(state.characterRevisionId, null);
  assert.equal(state.characterName, "");
  // Resetting an already-empty control is a no-op.
  const fresh = initialCharacterControlState();
  assert.equal(reduceCharacterControl(fresh, { type: "session.changed", sessionId: null }), fresh);
}

// --- Removed turn.state branch is inert ----------------------------------------
{
  const state = initialCharacterControlState();
  assert.equal(
    reduceCharacterControl(state, { type: "turn.state", running: true }),
    state,
    "unknown/removed actions must return the state untouched",
  );
  assert.ok(!("turnRunning" in state), "turnRunning is main-side admission, not UI state");
}

// --- Long CJK / RTL names are stored verbatim --------------------------------
{
  const longName = "夜游神·リラ・\u202Bレイラ\u202C——一个名字非常非常非常长的角色" + "長".repeat(80);
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "s1",
  });
  state = reduceCharacterControl(state, {
    type: "characters.loaded",
    characters: [
      { id: "char-1", displayName: longName, currentRevisionId: "rev-1" },
    ],
  });
  assert.equal(state.characters[0].displayName, longName, "names must not be truncated in state");
  state = reduceCharacterControl(state, {
    type: "selection.started",
    mode: "character",
    characterRevisionId: "rev-1",
    characterName: longName,
  });
  assert.equal(state.characterName, longName);
}

// --- characters.loaded resolves the bound character name ---------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: { mode: "character", bindingVersion: 2, characterRevisionId: "rev-1" },
  });
  state = reduceCharacterControl(state, {
    type: "characters.loaded",
    characters: [
      { id: "char-1", displayName: "巡夜人", currentRevisionId: "rev-1" },
      { id: "char-2", displayName: "抄写员", currentRevisionId: "rev-2" },
    ],
  });
  assert.equal(state.characterName, "巡夜人");
}

// --- Import preview keeps counts and security warnings -----------------------
{
  const preview = {
    previewToken: "a".repeat(64),
    format: "v2_json",
    container: "png",
    canonical: { name: "导入的角色" },
    compatibility: {
      level: "safe_behavior",
      counts: {
        supported: 8,
        migrated: 1,
        preservedInert: 2,
        ignoredInvalid: 0,
        rejectedExecutable: 1,
      },
      truncation: { omittedEntries: 3 },
      warnings: [{ code: "COMPATIBILITY_REPORT_TRUNCATED", omittedEntries: 3 }],
    },
    duplicates: { exact: null, canonical: { entityId: "char-x" } },
  };
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "s1",
  });
  state = reduceCharacterControl(state, { type: "import.previewLoaded", preview });
  assert.equal(state.importPreview.previewToken, preview.previewToken);
  assert.equal(state.importPreview.sessionId, "s1", "the preview pins its originating session");
  assert.equal(state.importPreview.name, "导入的角色");
  assert.equal(state.importPreview.format, "v2_json");
  assert.equal(state.importPreview.level, "safe_behavior");
  assert.equal(state.importPreview.supportedCount, 8);
  assert.equal(state.importPreview.inertCount, 2);
  assert.equal(state.importPreview.duplicateKind, "canonical");
  const warningCodes = state.importPreview.warnings.map((warning) => warning.code);
  assert.ok(warningCodes.includes("EXECUTABLE_REJECTED"), "rejected executable content must surface a warning");
  assert.ok(warningCodes.includes("COMPATIBILITY_REPORT_TRUNCATED"), "truncation must surface a warning");
}

// --- NOT_A_CHARACTER_CARD closes the flow toward ordinary attachment ---------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "s1",
  });
  state = reduceCharacterControl(state, {
    type: "import.previewFailed",
    error: "NOT_A_CHARACTER_CARD",
  });
  assert.equal(state.importPreview, null, "no dead modal may remain");
  assert.equal(state.notice, "ordinary_attachment");
}

// --- Import errors fail open --------------------------------------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "s1",
  });
  state = reduceCharacterControl(state, {
    type: "import.previewFailed",
    error: "CARD_TOO_LARGE",
  });
  assert.equal(state.importPreview, null);
  assert.equal(state.notice, "import_too_large");

  state = reduceCharacterControl(state, {
    type: "import.previewFailed",
    error: "CHARACTER_WORLDS_UNAVAILABLE",
  });
  assert.equal(state.notice, "unavailable");
}

// --- Commit lifecycle ---------------------------------------------------------
{
  const preview = {
    previewToken: "b".repeat(64),
    format: "v1_json",
    container: "json",
    canonical: { name: "新角色" },
    compatibility: {
      level: "lossless_data",
      counts: { supported: 5, migrated: 0, preservedInert: 0, ignoredInvalid: 0, rejectedExecutable: 0 },
      truncation: null,
      warnings: [],
    },
    duplicates: { exact: null, canonical: null },
  };
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "s1",
  });
  state = reduceCharacterControl(state, { type: "import.previewLoaded", preview });
  state = reduceCharacterControl(state, { type: "import.commitStarted" });
  assert.equal(state.importCommitting, true);
  state = reduceCharacterControl(state, {
    type: "import.committed",
    character: { id: "char-new", displayName: "新角色", currentRevisionId: "rev-new" },
  });
  assert.equal(state.importPreview, null);
  assert.equal(state.importCommitting, false);
  assert.ok(
    state.characters.some((c) => c.id === "char-new"),
    "a committed character joins the local recent list",
  );
}

// --- Expired preview dismisses the flow ---------------------------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "session.changed",
    sessionId: "s1",
  });
  state = reduceCharacterControl(state, {
    type: "import.previewLoaded",
    preview: {
      previewToken: "c".repeat(64),
      format: "v1_json",
      canonical: { name: "x" },
      compatibility: { level: "lossless_data", counts: { supported: 1 }, warnings: [] },
      duplicates: {},
    },
  });
  state = reduceCharacterControl(state, { type: "import.commitStarted" });
  state = reduceCharacterControl(state, {
    type: "import.commitFailed",
    error: "IMPORT_PREVIEW_EXPIRED",
  });
  assert.equal(state.importPreview, null, "an expired preview cannot be retried in place");
  assert.equal(state.importCommitting, false);
  assert.equal(state.notice, "import_expired");
}

// --- Availability kill switch: native Lily, binding preserved -----------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "binding.loaded",
    sessionId: "s1",
    binding: characterBinding,
  });
  state = reduceCharacterControl(state, {
    type: "availability.set",
    available: false,
  });
  assert.equal(state.available, false);
  assert.equal(state.mode, "character", "the stored binding survives a kill switch");
  assert.equal(effectiveCharacterMode(state), "native", "the conversation falls back to native Lily");
  assert.equal(state.notice, "unavailable");
}

// --- Notice dismissal ----------------------------------------------------------
{
  let state = reduceCharacterControl(initialCharacterControlState(), {
    type: "import.previewFailed",
    error: "CHARACTER_WORLDS_UNAVAILABLE",
  });
  assert.equal(state.notice, "unavailable");
  state = reduceCharacterControl(state, { type: "notice.dismissed" });
  assert.equal(state.notice, null);
}

// --- Static UI contract: one composer-owned trigger, no historical duplicate --
{
  const [html, librarySource, css] = await Promise.all([
    readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/modules/character-library.js", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/styles/character-worlds.css", import.meta.url), "utf8"),
  ]);
  assert.equal((html.match(/id="sessionRoleBanner"/g) || []).length, 1, "there must be exactly one role selector");
  assert.match(html, /<button id="sessionRoleBanner"[^>]*aria-controls="characterPopover"/, "the selector must be a native button wired to its popover");
  assert.equal(html.includes('id="sessionCharacterBtn"'), false, "the old toolbar trigger must stay removed");
  assert.ok(
    /class="composer-toolbar">[\s\S]*id="sessionRoleBanner"[\s\S]*id="sessionSkillsBtn"/.test(html),
    "the conversation context selector belongs inside the composer toolbar",
  );
  assert.equal(librarySource.includes("sessionCharacterBtn"), false, "library focus must never target the removed trigger");
  assert.ok(
    (librarySource.match(/sessionRoleBanner/g) || []).length >= 2,
    "AI authoring and library close must restore the new selector state/focus",
  );
  assert.equal(css.includes(".composer-character-btn"), false, "obsolete toolbar styles must not return");
}

// --- Binding projection restores the trusted display name after reload -------
{
  const state = reduceCharacterControl(
    initialCharacterControlState({ sessionId: "session-a" }),
    {
      type: "binding.loaded",
      sessionId: "session-a",
      seq: 0,
      binding: characterBinding,
      characterName: "糖糖",
    },
  );
  assert.equal(state.characterName, "糖糖", "binding reads restore the main-resolved character name");
}

// --- Context renderer: native/character state and accessible context labels ---
{
  const avatar = { textContent: "" };
  const name = { textContent: "" };
  const badges = {
    children: [],
    appendChild(child) { this.children.push(child); },
  };
  Object.defineProperty(badges, "textContent", {
    get() { return this.children.map((child) => child.textContent).join(""); },
    set() { this.children = []; },
  });
  const classes = new Set();
  const attributes = new Map();
  const banner = {
    hidden: true,
    title: "",
    classList: { toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } },
    querySelector(selector) {
      return new Map([
        [".session-role-banner-avatar", avatar],
        [".session-role-banner-name", name],
        [".session-role-banner-badges", badges],
      ]).get(selector);
    },
    setAttribute(key, value) { attributes.set(key, value); },
  };
  let state = {
    available: true,
    sessionId: "session-a",
    mode: "character",
    characterRevisionId: "revision-a",
    characterName: "糖糖",
    personaRevisionId: "persona-a",
    worldBookRevisionId: "world-a",
  };
  const labels = {
    "character.unnamed": "未命名角色",
    "character.nativeOption": "Lily 原声",
    "character.contextPersona": "设定",
    "character.contextWorld": "世界书",
    "character.application.selected": "已选择",
    "character.application.applied": "已生效",
    "character.application.bypassed": "本轮未应用",
    "character.roleBannerTitle": "当前对话角色，点击切换",
  };
  const render = createRoleBannerRenderer({
    getState: () => state,
    getElement: () => banner,
    monogram: (value) => value.slice(0, 1),
    el: (_tag, _className, props) => ({ ...props }),
    t: (key) => labels[key],
  });
  render();
  assert.equal(banner.hidden, false);
  assert.equal(name.textContent, "糖糖");
  assert.deepEqual(badges.children.map((child) => child.textContent), ["已选择", "设定", "世界书"]);
  assert.match(attributes.get("aria-label"), /糖糖 · 已选择 · 设定 · 世界书/);
  state = { ...state, application: { status: "applied", revisionId: "revision-a" } };
  render();
  assert.deepEqual(badges.children.map((child) => child.textContent), ["已生效", "设定", "世界书"]);
  assert.equal(classes.has("is-character"), true);

  state = { available: true, sessionId: "session-a", mode: "native" };
  render();
  assert.equal(name.textContent, "Lily 原声");
  assert.equal(badges.children.length, 0, "native mode must clear character context badges");
  assert.equal(classes.has("is-character"), false);
}

console.log("character session control reducer: ok");
