#!/usr/bin/env node
/**
 * The address book, and the four defects it was measured to have.
 *
 * Every check here corresponds to something that was rendered and measured,
 * not to a preference:
 *   1. `.collaboration-social-row` had no `display`, so a row was a block and
 *      its avatar, name and buttons stacked: 220px per contact against the
 *      56px an address book gets. Its own children were already written for a
 *      flex row, so only the parent was missing.
 *   2. every contact carried three always-visible text buttons, two of them
 *      destructive, given the same weight as "open chat".
 *   3. the view had its own search box placed BELOW the list it filtered,
 *      while the panel's search box was hidden in that view.
 *   4. `team:t_abc` — an internal addressing string — was printed on team
 *      headers and on every channel subtitle.
 *
 * Sectioning is checked as behaviour rather than as CSS: a name must land in
 * its pinyin section, because that is the whole reason the list is navigable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const { sectionLetter, groupByLetter } = await import(
  url.pathToFileURL(path.join(ROOT, "src/renderer/modules/contact-sections.js")).href
);

// ---- 1. Pinyin sectioning ------------------------------------------------
for (const [name, letter] of [
  ["李知遥", "L"], ["林晚", "L"], ["陈默", "C"], ["赵向前", "Z"], ["欧阳", "O"],
  ["钱多多", "Q"], ["孙悟空", "S"], ["马云", "M"], ["徐一", "X"], ["广告号", "G"],
  ["阿强", "A"], ["Alice Zhou", "A"], ["bob", "B"],
]) {
  assert.equal(sectionLetter(name), letter, `${name} belongs under ${letter}`);
}

// Anything without a letter must fall into one bucket rather than being forced
// under a wrong initial.
for (const other of ["123号", "😀", "Привет", "…", "", "   ", null, undefined, 42]) {
  assert.equal(sectionLetter(other), "#", `${JSON.stringify(other)} has no letter section`);
}
assert.equal(sectionLetter("  张三  "), "Z", "surrounding whitespace does not change the section");

// A Latin name sections next to a Han name with the same initial. A raw pinyin
// sort puts every Latin name after every Han name, which would strand "Alice"
// at the bottom of the book instead of in the A section.
{
  const sections = groupByLetter([
    { displayName: "林晚" }, { displayName: "Alice Zhou" }, { displayName: "阿强" },
    { displayName: "123" }, { displayName: "陈默" }, { displayName: "李知遥" },
  ]);
  assert.deepEqual(sections.map((section) => section.letter), ["A", "C", "L", "#"],
    "sections are ordered A–Z with the letterless bucket last");
  assert.deepEqual(sections[0].people.map((person) => person.displayName), ["阿强", "Alice Zhou"],
    "a Latin name sits in its letter section, not after every Han name");
  assert.equal(sections.every((section) => section.people.length > 0), true, "no empty sections are emitted");
}

// Empty and malformed input yields an empty book, never a throw: this runs on
// every keystroke of the search box.
for (const shape of [undefined, null, "nope", 7, {}]) {
  assert.deepEqual(groupByLetter(shape), [], `malformed input yields no sections: ${JSON.stringify(shape)}`);
}
assert.deepEqual(groupByLetter([{}, { displayName: null }]).map((s) => s.letter), ["#"],
  "people with no name still get a section rather than being dropped");

// ---- 2. The row is a row ------------------------------------------------
{
  const css = read("src/renderer/styles/collaboration.css");
  // Anchored at a line start: `.collaboration-team > .collaboration-social-row`
  // also contains that substring and matched first.
  const rowRule = /^\.collaboration-social-row \{([^}]*)\}/m.exec(css);
  assert.ok(rowRule, "the contact row rule must exist");
  const block = rowRule[1];
  assert.match(block, /display:\s*flex/, "a contact row must be a flex row; without this its children stack (~220px per contact)");
  assert.match(block, /min-height:\s*5[0-9]px/, "a contact row is a ~56px list row");
  assert.match(css, /\.collaboration-row-open\s*\{[^}]*flex:\s*1 1 auto/, "the row body fills the row so the whole row is the click target");

  // Destructive actions must not be words sitting on the row. They are
  // icon-only and revealed on hover/focus; the space is reserved so the row
  // does not reflow under the pointer.
  const actions = css.slice(css.indexOf(".collaboration-social-actions {"));
  assert.match(actions.slice(0, actions.indexOf("}")), /opacity:\s*0/,
    "row actions start hidden; they were unconditionally opaque, which with a block row meant a wall of buttons");
  assert.match(css, /@media \(hover: none\)[^}]*\{[^}]*\.collaboration-social-actions\s*\{\s*opacity:\s*1/s,
    "with no pointer there is no hover, so the actions must be visible");
}

// ---- 3. One search box, owned by the panel ------------------------------
{
  const friends = read("src/renderer/modules/collaboration-friends.js");
  assert.ok(!/type\s*=\s*"search"/.test(friends) && !/collaboration-search/.test(friends),
    "the contacts view must not build its own search input: the panel header owns the one search box");
  assert.match(friends, /setFilter\(value\)/, "the panel drives this view's filter instead");

  const center = read("src/renderer/modules/collaboration-center.js");
  assert.match(center, /inboxSearch\.hidden\s*=\s*section === "teams"/,
    "the panel search stays visible in the contacts view; hiding it there is why a second box was added");
  assert.match(center, /activeSection === "people"[\s\S]{0,80}friends\.setFilter/,
    "input in the one search box is routed to the list on screen");
}

// ---- 4. Internal ids are never printed ----------------------------------
{
  const teams = read("src/renderer/modules/collaboration-teams.js");
  // `teamLabel` is what every channel subtitle and pending-command label runs
  // through, so this single function is where the leak was.
  assert.ok(!/\$\{team\.scopeId\}/.test(teams) && !/\$\{conversation\.scopeId\}/.test(teams),
    "a raw scope id (team:t_abc) must never be interpolated into user-facing text");
  assert.match(teams, /const teamLabel = \(team\) => team\.name;/, "a team is named by its name alone");

  // Members were listed inline for every team, which buries the channels — the
  // thing people open — under a roster that a real team makes unreadable.
  assert.match(teams, /showTeam\(teamId\)/, "the roster is reachable on demand from the team header");
  assert.match(teams, /collaboration-team-channels/, "channels are their own nested group under the team");
}

// The whole address book must survive being rendered with no data at all.
{
  const friends = read("src/renderer/modules/collaboration-friends.js");
  const guardLine = friends.split("\n").find((line) => line.includes("!root?.querySelectorAll")) || "";
  assert.match(guardLine, /setFilter\(\)/,
    "the no-op controller must expose setFilter too, or the panel's search throws when the view is absent");
}

console.log("collaboration-address-book: ok");
