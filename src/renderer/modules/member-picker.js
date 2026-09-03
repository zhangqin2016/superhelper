import { t } from "../i18n/index.js";
import { socialNode, socialAvatar, identityName } from "./collaboration-social-ui.js";
import { groupByLetter } from "./contact-sections.js";

/**
 * Picking people, as a picker.
 *
 * This replaces a `<select multiple>`: a 96px box, no search, no avatars, no
 * count, and modifier-clicking to choose more than one. That control is
 * unusable past a handful of contacts, and it gave no feedback about who was
 * chosen — measured before it was replaced.
 *
 * Selection is held as a Set of ids and survives filtering, so typing in the
 * search box cannot silently drop someone already chosen. That is the one
 * behaviour a naive rebuild gets wrong.
 */

/** WeChat's default: the members' names, so a group need not be named to exist. */
export function derivedGroupTitle(names, { maxNames = 3, maxLength = 200 } = {}) {
  const labels = (Array.isArray(names) ? names : []).map((name) => String(name ?? "").trim()).filter(Boolean);
  if (!labels.length) return "";
  const head = labels.slice(0, maxNames).join("、");
  // Deliberately not an i18n string: `t()` returns the KEY when no locale has
  // loaded yet, which would make the group's name literally
  // "collaboration.social.groupTitleMore". The names are the point, and "+2"
  // reads the same in every locale.
  const title = labels.length > maxNames ? `${head} +${labels.length - maxNames}` : head;
  // The server caps a title at 200 characters; cut here so a long roster
  // cannot turn a valid pick into a rejected command.
  return title.length > maxLength ? title.slice(0, maxLength) : title;
}

/**
 * @param minimum how many people must be chosen for `satisfied()` to hold
 * @param single  radio semantics: choosing someone clears the previous choice.
 *                Used where the command takes ONE target per call, so offering
 *                multi-select would promise a batch the command layer cannot
 *                deliver.
 */
export function createMemberPicker({ minimum = 1, single = false, onChange = () => {} } = {}) {
  const root = socialNode("div", "", "collaboration-member-picker");

  const search = document.createElement("input");
  search.type = "search"; search.className = "collaboration-search"; search.autocomplete = "off";
  search.placeholder = t("collaboration.social.pickMembers");
  search.setAttribute("aria-label", t("collaboration.social.pickMembers"));

  const strip = socialNode("div", "", "collaboration-picker-strip");
  const list = socialNode("div", "", "collaboration-picker-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", t("collaboration.social.pickMembers"));
  root.append(search, strip, list);

  let people = [];
  let filter = "";
  const selected = new Set();

  const nameOf = (person) => identityName(person);
  const selectedPeople = () => people.filter((person) => selected.has(person.userId));

  function paintStrip() {
    strip.replaceChildren();
    const chosen = selectedPeople();
    // The count is the thing a person checks before committing, so it is text
    // rather than something to infer from the highlighted rows.
    strip.hidden = chosen.length === 0;
    if (!chosen.length) return;
    strip.append(socialNode("small", t("collaboration.social.selectedCount", { count: chosen.length }), "collaboration-picker-count"));
    for (const person of chosen) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "collaboration-picker-chip";
      chip.dataset.userId = person.userId;
      const label = nameOf(person);
      chip.setAttribute("aria-label", `${t("collaboration.social.deselect")}: ${label}`);
      chip.title = chip.getAttribute("aria-label");
      chip.append(socialAvatar(label), socialNode("span", label));
      chip.addEventListener("click", () => { selected.delete(person.userId); paint(); });
      strip.append(chip);
    }
  }

  function matches(person, needle) {
    if (!needle) return true;
    return [person.displayName, person.lilyId, person.userId]
      .some((value) => String(value || "").toLocaleLowerCase().includes(needle));
  }

  function paintList() {
    list.replaceChildren();
    const needle = filter.trim().toLocaleLowerCase();
    const visible = people.filter((person) => matches(person, needle));
    if (!visible.length) { list.append(socialNode("p", t("collaboration.noFriends"), "collaboration-empty")); return; }
    for (const section of groupByLetter(visible, nameOf)) {
      const heading = socialNode("div", section.letter, "collaboration-section-letter");
      heading.dataset.letter = section.letter;
      list.append(heading);
      for (const person of section.people) {
        // A <label> rather than a div with a click handler: the whole row is
        // the checkbox's own hit area and its accessible name, for free.
        const row = socialNode("label", "", "collaboration-social-row is-pick");
        row.dataset.userId = person.userId;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selected.has(person.userId);
        box.addEventListener("change", () => {
          if (box.checked) {
            if (single) selected.clear();
            selected.add(person.userId);
          } else selected.delete(person.userId);
          // Repaint the strip and the count, but NOT the list: rebuilding it
          // here would move the row out from under the pointer mid-click. In
          // single mode the other boxes still have to be cleared, so only
          // their `checked` is touched — the rows themselves stay put.
          if (single) {
            for (const other of list.querySelectorAll('.is-pick input[type="checkbox"]')) {
              if (other !== box) other.checked = false;
            }
          }
          paintStrip();
          onChange(controller);
        });
        const body = socialNode("span", "", "collaboration-row-open is-static");
        const label = nameOf(person);
        body.append(socialAvatar(label));
        const content = socialNode("span", "", "collaboration-row-content");
        content.append(socialNode("strong", label));
        if (person.lilyId) content.append(socialNode("small", person.lilyId));
        body.append(content);
        row.append(box, body);
        list.append(row);
      }
    }
  }

  function paint() { paintStrip(); paintList(); onChange(controller); }

  search.addEventListener("input", () => { filter = search.value; paintList(); });

  const controller = {
    node: root,
    /** Selection is kept across a roster refresh for anyone still present. */
    setPeople(next) {
      people = (Array.isArray(next) ? next : []).filter((person) => typeof person?.userId === "string" && person.userId);
      const present = new Set(people.map((person) => person.userId));
      for (const userId of [...selected]) if (!present.has(userId)) selected.delete(userId);
      paint();
    },
    selectedIds() { return selectedPeople().map((person) => person.userId); },
    selectedNames() { return selectedPeople().map((person) => nameOf(person)); },
    count() { return selectedPeople().length; },
    satisfied() { return selectedPeople().length >= minimum; },
    minimum,
    /** Selection as plain ids, for carrying across a rebuild of the form. */
    snapshot() { return [...selected]; },
    /** Restore a snapshot, keeping only people who are still selectable. */
    restore(ids) {
      selected.clear();
      const present = new Set(people.map((person) => person.userId));
      for (const userId of Array.isArray(ids) ? ids : []) {
        if (typeof userId !== "string" || !present.has(userId)) continue;
        if (single && selected.size) break;
        selected.add(userId);
      }
      paint();
    },
    reset() { selected.clear(); filter = ""; search.value = ""; paint(); },
  };
  return controller;
}
