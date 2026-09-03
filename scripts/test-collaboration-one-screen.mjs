#!/usr/bin/env node
/**
 * One screen shows one thing.
 *
 * What it looked like before, from a screenshot of the running app: a single
 * scrolling column held the panel's title ("协作中心"), the list's own title
 * ("团队"), a create action, a "个人" section of groups, a "团队" section with
 * its empty state, AND the member roster of a conversation somebody had
 * tapped. Two titles for one place, and browse and detail stacked together —
 * "I can't tell what's what" was the accurate description.
 *
 * The panel already had the right shape for this: opening a conversation swaps
 * the home view for a view with its own header and a back button. Rosters and
 * pending requests now use the same shape instead of appending into the list
 * they came from.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const html = read("src/renderer/index.html");

// ---- Exactly one title names where you are -----------------------------
{
  assert.match(html, /id="collaborationPanelTitle"/, "the panel header carries the destination name");
  assert.doesNotMatch(html, /id="collaborationListTitle"/,
    "the list must not carry a second title: the header already names the destination");
  const center = read("src/renderer/modules/collaboration-center.js");
  assert.match(center, /if \(panelTitle\) panelTitle\.textContent = t\(`collaboration\.\$\{section\}`\)/,
    "the one title follows the active destination");
  // The rail is icon-only, so if the header stopped naming the destination
  // there would be nothing left that does.
  for (const id of ["collaborationInboxTab", "collaborationPeopleTab", "collaborationTeamsTab"]) {
    const tab = new RegExp(`<button id="${id}"[^>]*>`).exec(html);
    assert.ok(tab && !/>[^<]/.test(tab[0]), `${id} is icon-only, so the header must name the destination`);
  }
}

// ---- A detail is its own screen, beside the list -----------------------
{
  assert.match(html, /id="collaborationDetail"[^>]*hidden/, "a detail view exists and starts closed");
  assert.match(html, /id="collaborationDetailBack"/, "and it has a back button, like a conversation does");
  assert.match(html, /id="collaborationDetailTitle"/, "and its own title");
  assert.match(html, /id="collaborationDetailBody"/, "and its own body");
  // It must be a SIBLING of the list column, not inside it — being inside is
  // exactly the defect.
  const home = html.slice(html.indexOf('id="collaborationHome"'), html.indexOf('id="collaborationConversation"'));
  const listAt = home.indexOf('id="collaborationInboxColumn"');
  const detailAt = home.indexOf('id="collaborationDetail"');
  assert.ok(listAt > 0 && detailAt > listAt, "the detail view sits beside the list column, not within it");
  const listColumn = home.slice(listAt, detailAt);
  assert.doesNotMatch(listColumn, /collaborationDetailBody/, "the detail body is not nested in the list column");

  // The surface itself moved into its own module; the centre wires it.
  const surfaces = read("src/renderer/modules/collaboration-panel-surfaces.js");
  assert.match(surfaces, /listColumn\.hidden = true;\s*\n\s*view\.hidden = false;/,
    "opening a detail hides the list, so only one of the two is on screen");
  assert.match(surfaces, /back\?\.addEventListener\("click", close\)/, "back leaves the detail");
  const center = read("src/renderer/modules/collaboration-center.js");
  assert.match(center, /createDetailSurface\(\{/, "the centre wires that surface rather than building its own");
  // Switching destination must not leave someone else's roster on screen.
  assert.match(center, /closeDetail\(\);\s*\n\s*\/\/ Render the destination now/,
    "changing destination closes any open detail");
}

// ---- The views render into it, and still work without it ---------------
{
  const teams = read("src/renderer/modules/collaboration-teams.js");
  assert.match(teams, /const detailSurface = \(title\) => detail\?\.open\?\.\(title\) \|\| details;/,
    "teams draws a roster on the detail surface, falling back to its inline container when there is none");
  // The fallback matters: these modules are rendered standalone by the DOM
  // tests, with no panel around them.
  assert.match(teams, /if \(surface === details\)/,
    "the inline fallback still gets a heading, since it has no header of its own");
  assert.match(teams, /showTeam\(teamId\)/, "the roster is still reachable");

  const friends = read("src/renderer/modules/collaboration-friends.js");
  assert.match(friends, /requestsOpen && detail\?\.open \? detail\.open\(t\("collaboration\.social\.newFriends"\)\) : requestsPanel/,
    "pending requests are their own screen when there is a detail view");
  assert.match(friends, /if \(!requestsOpen\) \{ detail\?\.close\?\.\(\); return; \}/,
    "closing the requests entry leaves the detail screen");
  assert.match(friends, /detail\?\.close\?\.\(\);/, "a reset dismisses any open detail");
}

// ---- Entries line up with the avatar column ----------------------------
{
  const css = read("src/renderer/styles/collaboration.css");
  assert.match(css, /\.collaboration-disclosure\.is-entry-row > \.collaboration-disclosure-trigger \{[^}]*padding-inline-start: 56px/s,
    "an entry that opens something lines up with the avatar column");
  for (const [file, label] of [
    ["src/renderer/modules/collaboration-friends.js", "add a contact"],
    ["src/renderer/modules/collaboration-teams.js", "create a group"],
  ]) {
    assert.match(read(file), /classList\.add\("is-row", "is-entry-row"\)/,
      `the ${label} entry is a row, not a text link floating above the section headings`);
  }
}

console.log("collaboration-one-screen: ok");
