#!/usr/bin/env node
/**
 * Creating a group.
 *
 * Measured before it was rebuilt, against what every chat client does:
 *   - the member control was a `<select multiple>`, 361x96, with no search, no
 *     avatars and no indication of who was chosen. Picking more than one
 *     person required a modifier click.
 *   - the group NAME was the first field and it was REQUIRED, so a group had
 *     to be named before anyone was chosen. The server never required it:
 *     `title: (raw.title || "").trim()`, capped at 200 characters.
 *   - a group could be created with NOBODY in it. The server imposes no
 *     minimum either, so nothing stopped a "group" of one.
 *
 * The pure parts are tested as behaviour here; the DOM behaviour (disabled
 * submit, selection surviving a filter, chip removal) is pinned in
 * test-collaboration-social-ui.cjs against a real Electron DOM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

// The picker builds DOM at import time only inside its factory, so the module
// itself is importable without a document; `derivedGroupTitle` is pure.
globalThis.document = globalThis.document || undefined;
const { derivedGroupTitle } = await import(
  url.pathToFileURL(path.join(ROOT, "src/renderer/modules/member-picker.js")).href
);

// ---- A blank name becomes the members' names ---------------------------
assert.equal(derivedGroupTitle(["张三", "李四"]), "张三、李四", "two members name the group");
assert.equal(derivedGroupTitle(["张三", "李四", "王五"]), "张三、李四、王五", "three members name the group in full");
assert.equal(derivedGroupTitle(["张三", "李四", "王五", "赵六"]), "张三、李四、王五 +1",
  "beyond three the first three lead and the rest are counted");
// The count marker must not go through `t()`: with no locale loaded that
// returns the KEY, which would become the group's actual name.
assert.doesNotMatch(derivedGroupTitle(["a", "b", "c", "d", "e"]), /collaboration\./,
  "a derived name can never contain an i18n key");
assert.equal(derivedGroupTitle([]), "", "no members yields no derived name, so nothing is invented");
for (const shape of [undefined, null, "nope", 7, [null, "", "   "]]) {
  assert.equal(derivedGroupTitle(shape), "", `malformed input yields no name: ${JSON.stringify(shape)}`);
}
// The server rejects a title over 200 characters, so a long roster must not
// turn a valid pick into a failed command.
{
  const long = derivedGroupTitle(Array.from({ length: 40 }, (_, index) => `成员名字很长的人${index}`));
  assert.ok(long.length > 0 && long.length <= 200, `a derived title stays within the server's cap: ${long.length}`);
}

// ---- The form asks for members first, and the name is optional ---------
{
  const teams = read("src/renderer/modules/collaboration-teams.js");
  const formSetup = teams.slice(teams.indexOf('groupForm.dataset.form = "group"'), teams.indexOf("const list = socialNode"));
  assert.ok(formSetup.indexOf("createMemberPicker") < formSetup.indexOf('socialField(groupForm, "title"'),
    "the member picker comes before the name field; the name used to be first and required");
  assert.doesNotMatch(formSetup, /groupTitle\.required = true/,
    "the group name must not be required: the server accepts an empty title and derives nothing from it");
  assert.match(formSetup, /createMemberPicker\(\{ minimum: 1/,
    "a group needs at least one other person; a one-to-one conversation is already the direct kind");

  // The submit must be gated on the selection, in the handler as well as on
  // the button — a disabled button alone is bypassed by requestSubmit().
  assert.match(teams, /if \(!groupMembers\.satisfied\(\)\) return;/,
    "the submit handler itself refuses an empty selection, not just the disabled button");
  assert.match(teams, /createGroup\.disabled = !groupMembers\.satisfied\(\)/, "the button reflects the same rule");
  assert.match(teams, /groupTitle\.value\.trim\(\) \|\| derivedGroupTitle\(groupMembers\.selectedNames\(\)\)/,
    "a blank name falls back to the members' names");
  assert.doesNotMatch(teams, /groupMembers\.replaceChildren/,
    "no leftover <select> calls on the picker: reset() must go through its own API");
}

// ---- The picker keeps its selection across a filter and a refresh ------
{
  const picker = read("src/renderer/modules/member-picker.js");
  // Selection lives in a Set of ids, not in the DOM, which is what makes it
  // survive a re-render. A naive rebuild loses whoever is filtered out.
  assert.match(picker, /const selected = new Set\(\);/, "selection is held outside the DOM");
  assert.match(picker, /search\.addEventListener\("input", \(\) => \{ filter = search\.value; paintList\(\); \}\);/,
    "typing repaints only the list, so the selected strip and count are untouched");
  assert.match(picker, /for \(const userId of \[\.\.\.selected\]\) if \(!present\.has\(userId\)\) selected\.delete\(userId\)/,
    "a refresh drops only people who are no longer selectable, so a blocked contact cannot stay silently selected");
  // Repainting the list from inside a checkbox handler would move the row out
  // from under the pointer mid-click.
  const onChangeBlock = picker.slice(picker.indexOf('box.addEventListener("change"'), picker.indexOf("const body = socialNode"));
  assert.doesNotMatch(onChangeBlock, /paintList\(\)/, "ticking a box must not rebuild the list under the pointer");
  assert.match(onChangeBlock, /paintStrip\(\)/, "ticking a box does update the strip and the count");
}

// ---- The row is a real 56px row, and a label ---------------------------
{
  const css = read("src/renderer/styles/collaboration.css");
  const pick = /\.collaboration-social-row\.is-pick \{([^}]*)\}/.exec(css);
  assert.ok(pick, "the pick row has its own rule");
  // `.collaboration-social-form label` sets `display: grid` and, being
  // class+element, outranks the single-class row rule — which stacked the
  // checkbox above the name and measured 77px instead of 56px.
  assert.match(pick[1], /display:\s*flex/,
    "the pick row must restate display: flex to outrank .collaboration-social-form label");
  const picker = read("src/renderer/modules/member-picker.js");
  assert.match(picker, /socialNode\("label", "", "collaboration-social-row is-pick"\)/,
    "a pick row is a <label>, so the whole row is the checkbox's hit area and accessible name");
}

console.log("collaboration-member-picker: ok");
