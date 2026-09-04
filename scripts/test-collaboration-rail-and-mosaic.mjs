#!/usr/bin/env node
/**
 * The navigation rail, and composed group avatars.
 *
 * Both replace something measurably worse:
 *   - the three destinations lived in a header `<details>` popover behind a
 *     hamburger. Three places you switch between constantly, with the current
 *     one invisible until you opened the menu.
 *   - every conversation's avatar was the first character of its TITLE, so in
 *     a workspace full of "设计…" and "周会…" the tiles were identical. A group
 *     now composes its tile from who is in it.
 *
 * The roster that feeds the tile is a DRAWING input. It must never become a
 * membership or permission signal: bounded, re-validated at the IPC boundary,
 * and absent for a direct chat, which keeps the single initial.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const { conversationRosters, MAX_MEMBERS_PER_CONVERSATION } = require("../src/main/collaboration/conversation-rosters");

// ---- The rail is persistent, not a popover -------------------------------
{
  const html = read("src/renderer/index.html");
  assert.doesNotMatch(html, /collaborationNavMenu/, "the destinations must not go back behind a <details> popover");
  assert.match(html, /id="collaborationRail"[^>]*class="[^"]*collaboration-rail/, "a persistent rail exists");
  for (const id of ["collaborationInboxTab", "collaborationPeopleTab", "collaborationTeamsTab"]) {
    const tab = new RegExp(`<button id="${id}"[^>]*>`).exec(html);
    assert.ok(tab, `${id} exists`);
    // Icon-only tiles: without a translated accessible name the rail is three
    // unlabelled glyphs, and `data-i18n` cannot be used because the applier
    // sets textContent and would delete the <svg>.
    assert.match(tab[0], /data-i18n-aria-label="collaboration\./, `${id} carries a translated accessible name`);
    assert.match(tab[0], /data-i18n-title="collaboration\./, `${id} carries a translated tooltip`);
    assert.doesNotMatch(tab[0], /\sdata-i18n=/, `${id} must not use data-i18n: the applier sets textContent and would delete its icon`);
  }
  assert.match(html, /id="collaborationRailUnread"/, "the rail shows unread as a dot");

  const css = read("src/renderer/styles/collaboration.css");
  // `.collaboration-nav` sets `display: grid` (the old segmented control) and
  // is declared LATER in the sheet, so the rail must win on specificity rather
  // than on order — this exact bug rendered the three icons side by side.
  assert.match(css, /\.collaboration-nav\.collaboration-rail\s*\{[^}]*flex-direction:\s*column/s,
    "the rail must outrank .collaboration-nav's grid by specificity, not by source order");
  assert.match(css, /^\.collaboration-home\s*\{[^}]*flex-direction:\s*row/ms, "the home view is rail | list");

  const center = read("src/renderer/modules/collaboration-center.js");
  // The badge/dot pair moved into its own module; the centre wires both to it.
  assert.match(read("src/renderer/modules/collaboration-unread-badge.js"), /railUnread\.hidden = total <= 0/,
    "the rail dot follows the same unread total as the panel badge");
  assert.match(center, /createUnreadBadge\(\{ railUnread, unreadBadge/, "the centre wires the rail dot and the panel badge together");
  assert.match(center, /title\.hidden = false/, "the list heading always names the destination; the rail is icon-only");
}

// ---- The roster is bounded, ordered, and fail-open ----------------------
{
  const rows = [];
  for (let index = 0; index < 30; index += 1) rows.push({ conversation_id: "c1", user_id: `u${index}` });
  rows.push({ conversation_id: "c2", user_id: "a" }, { conversation_id: "c2", user_id: "b" });
  const store = { accountId: "acct", db: { all: () => rows } };
  const rosters = conversationRosters(store);
  assert.equal(rosters.get("c1").length, MAX_MEMBERS_PER_CONVERSATION,
    "a large conversation is capped: more members cannot be told apart in a 40px tile");
  assert.deepEqual(rosters.get("c1").slice(0, 3), ["u0", "u1", "u2"], "the cap keeps the first members, in query order");
  assert.deepEqual(rosters.get("c2"), ["a", "b"], "a small conversation keeps everyone");

  // A roster is worth an avatar, not a failed conversation list.
  const broken = { accountId: "acct", db: { all: () => { throw new Error("no such table"); } } };
  assert.deepEqual([...conversationRosters(broken).keys()], [], "a failed roster read yields no rosters rather than throwing");

  const junk = { accountId: "acct", db: { all: () => [null, 7, { conversation_id: 1, user_id: "x" }, { conversation_id: "c", user_id: null }, { conversation_id: "c", user_id: "ok" }] } };
  assert.deepEqual(conversationRosters(junk).get("c"), ["ok"], "malformed rows are skipped, not rendered");
}

// ---- The IPC boundary re-validates it ----------------------------------
{
  const ipc = read("src/main/ipc-collaboration.js");
  const projection = ipc.slice(ipc.indexOf("function rendererConversation"), ipc.indexOf("function rendererMessage"));
  assert.match(projection, /memberUserIds:/, "the conversation projection carries the roster");
  // Not `safeIdentifier`: it permits any non-whitespace string up to 200 chars
  // (it governs server-assigned message ids), so "../escape" passes it. This
  // field takes the account-id shape used for user and attachment ids instead.
  assert.match(projection, /\/\^\[A-Za-z0-9_-\]\{1,200\}\$\/\.test\(userId\)[\s\S]{0,40}\.slice\(0, 9\)/,
    "ids are re-validated against the strict identifier shape and bounded at the boundary");
  assert.doesNotMatch(projection, /memberUserIds:[\s\S]{0,160}safeIdentifier/,
    "memberUserIds must not fall back to the loose message-id check");
}

// ---- A direct chat keeps its single initial -----------------------------
{
  const inbox = read("src/renderer/modules/collaboration-inbox.js");
  assert.match(inbox, /conversation\.kind === "direct" \? \[\]/,
    "a one-to-one chat must not get a composed tile: there is one other person and their initial is the point");
  assert.match(inbox, /\.filter\(\(userId\) => userId !== currentUserId\)/,
    "the reader is left out of their own group tile");
  assert.match(inbox, /mosaicAvatar\(title, memberNames, avatarKind\)/, "the row uses the composed tile");

  const ui = read("src/renderer/modules/collaboration-social-ui.js");
  // One member (or none) has nothing to compose, so it must degrade to exactly
  // the tile that shipped before — never to an empty square.
  assert.match(ui, /if \(labels\.length < 2\) return socialAvatar\(title, kind\);/,
    "fewer than two names falls back to the title initial");
  assert.match(ui, /const columns = labels\.length <= 4 \? 2 : 3;/,
    "2x2 up to four, 3x3 beyond: a 3x3 holding five cells reads as a broken grid");
  assert.match(ui, /Math\.min\(labels\.length, columns \* columns\)/, "cells never exceed the grid");
  assert.match(ui, /tile\.setAttribute\("aria-hidden", "true"\)/,
    "the tile is decorative; the name is on the row, which is what lets its cells sit below the text floor");
}

console.log("collaboration-rail-and-mosaic: ok");
