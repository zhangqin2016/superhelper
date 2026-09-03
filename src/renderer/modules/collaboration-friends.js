import { t } from "../i18n/index.js";
import { createSocialUi, socialNode, socialButton, socialIconButton, socialRowButton, socialField, socialPerson, socialAvatar, socialDisclosure, identityName } from "./collaboration-social-ui.js";
import { groupByLetter } from "./contact-sections.js";

export function renderCollaborationFriends(node, relationships = []) {
  if (!node) return;
  node.replaceChildren();
  const rows = Array.isArray(relationships) ? relationships : [];
  if (rows.length === 0) { const empty = document.createElement("p"); empty.className = "collaboration-empty"; empty.textContent = t("collaboration.noFriends"); node.append(empty); return; }
  for (const relationship of rows) { const row = document.createElement("p"); row.textContent = identityName({ ...relationship, userId: relationship.peerUserId || relationship.userId }); node.append(row); }
}

/**
 * The address book, shaped like one.
 *
 * What it replaced, and why each part moved:
 *   - the view had its own search box, placed BELOW the list it filtered, while
 *     the panel's own search box was hidden in this view. There is now one
 *     search box, in the header, retargeted at whichever list is on screen
 *   - every contact carried three always-visible text buttons, two of them
 *     destructive, which cost ~220px per person. The row is now 56px, the
 *     primary action IS the row, and remove/block are icon actions that appear
 *     on hover or keyboard focus
 *   - incoming friend requests were interleaved with friends, so a pending
 *     request was something you had to notice. They now live behind one
 *     "new friends" entry that carries a count
 *   - the list was flat; it is now sectioned A–Z by pinyin, so a name can be
 *     found by its first letter instead of by scrolling
 *   - "my Lily ID" was a bare paragraph styled like a disabled input; it is a
 *     profile row with the avatar and the id
 */
export function initCollaborationFriends(root, { api = window.assistantClient?.collaboration, onChanged = async () => {}, onOpen = () => {}, getNavigationGeneration = () => 0, detail = null } = {}) {
  if (!root?.querySelectorAll) return { update() {}, reset() {}, setFilter() {} };
  root.replaceChildren();

  const profileRow = socialNode("div", "", "collaboration-social-row is-profile");
  const entries = socialNode("div", "", "collaboration-contact-entries");
  const requestsPanel = socialNode("div", "", "collaboration-request-panel"); requestsPanel.hidden = true;

  // Adding a contact used to be blind: type an exact Lily ID, submit, and find
  // out from a generic failure afterwards whether that person exists. The
  // server has always had a rate-limited lookup; it simply had no route.
  const addForm = socialNode("form", "", "collaboration-social-form");
  const lilyId = socialField(addForm, "lilyId", "exactLilyId"); lilyId.required = true; lilyId.maxLength = 64;
  const findButton = socialNode("button", t("collaboration.social.findContact"), "collaboration-social-primary");
  findButton.type = "submit"; findButton.dataset.action = "find-contact"; addForm.append(findButton);
  // What the lookup found: a real row, so you see who you are about to add.
  const foundBox = socialNode("div", "", "collaboration-lookup-result"); foundBox.hidden = true; addForm.append(foundBox);
  const lookupNote = socialNode("p", "", "collaboration-form-note"); lookupNote.hidden = true;
  lookupNote.setAttribute("role", "status"); addForm.append(lookupNote);
  const addDisclosure = socialDisclosure(t("collaboration.social.addContact"), addForm, { primary: true });
  addDisclosure.classList.add("is-row", "is-entry-row");

  const contacts = socialNode("div", "", "collaboration-contact-list");
  // No search input of its own: the panel header owns the one search box and
  // drives this view through `setFilter`. A second box, below the list it
  // filtered, was the previous shape.
  root.append(profileRow, entries, addDisclosure, requestsPanel, contacts);

  let filter = "", requestsOpen = false;
  let directoryCache = { contacts: [] };
  const ui = createSocialUi(root, { onChanged, getNavigationGeneration });

  let found = null;
  let lookupGeneration = 0;
  function clearLookup() {
    lookupGeneration += 1;
    found = null; foundBox.hidden = true; foundBox.replaceChildren();
    lookupNote.hidden = true; lookupNote.textContent = "";
    findButton.disabled = false;
  }
  lilyId.addEventListener("input", clearLookup);

  /** Show the person, then let the request be sent — with an optional greeting.
   *  The failure is deliberately unexplained: the server answers the same way
   *  for "no such id", "that is you", "hidden" and "blocked", because telling
   *  them apart would let anyone probe which Lily IDs exist. */
  function paintLookup(profile) {
    found = profile;
    foundBox.replaceChildren();
    foundBox.hidden = false;
    const name = identityName(profile);
    const row = socialNode("div", "", "collaboration-social-row");
    row.dataset.userId = profile.userId;
    row.append(socialRowButton(name, null, { avatar: socialAvatar(name), subtitle: profile.lilyId || "" }));
    row.firstChild.classList.add("is-static");
    foundBox.append(row);
    const greeting = document.createElement("input");
    // Its own class, not the search box's: a greeting is not a search, and
    // borrowing that class also tripped the guard that keeps this view from
    // growing a second search input.
    greeting.type = "text"; greeting.className = "collaboration-text-input"; greeting.maxLength = 500;
    greeting.placeholder = t("collaboration.social.greeting");
    greeting.setAttribute("aria-label", t("collaboration.social.greeting"));
    greeting.dataset.field = "greeting";
    const send = socialNode("button", t("collaboration.social.sendRequest"), "collaboration-social-primary");
    send.type = "button"; send.dataset.action = "send-request";
    send.addEventListener("click", () => {
      const target = found?.lilyId;
      if (!target) return;
      const message = greeting.value.trim();
      void ui.run(() => api.friend({ action: "request", lilyId: target, ...(message ? { message } : {}) }), () => {
        if (lilyId.value.trim().toLowerCase() === target) lilyId.value = "";
        clearLookup();
      });
    });
    foundBox.append(greeting, send);
  }

  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = lilyId.value.trim();
    if (!value) return;
    clearLookup();
    // Deliberately NOT through `ui.run`: that is the command path, and it
    // would leave a receipt-shaped status and trigger a full directory reload
    // for what is a read. It also owns the shared status line, which the
    // lookup should not take over.
    const generation = ++lookupGeneration;
    findButton.disabled = true;
    lookupNote.hidden = false;
    lookupNote.textContent = t("collaboration.social.searching");
    let result;
    try { result = await api.lookupFriend?.(value); } catch { result = null; }
    // A later lookup, a reset, or a switched account must win.
    if (generation !== lookupGeneration) return;
    findButton.disabled = false;
    if (result?.ok === true && result.profile?.userId) {
      lookupNote.hidden = true;
      paintLookup(result.profile);
      return;
    }
    lookupNote.textContent = t("collaboration.social.notFound");
  });

  async function change(action, contact, extra = {}) {
    const generation = ui.current();
    if (["remove", "block", "unblock", "decline"].includes(action)
      && !await ui.confirm(`confirm${action[0].toUpperCase()}${action.slice(1)}`, socialPerson(contact))) return;
    if (generation !== ui.current()) return;
    const command = action === "accept" || action === "decline" ? { action: "respond", requestId: contact.requestId, accept: action === "accept" }
      : { action, peerUserId: contact.userId, ...extra };
    await ui.run(() => api.friend(command));
  }

  const openChat = (contact) => ui.run(() => api.openFriend(contact.userId), (result, origin) => { if (origin.isCurrentNavigation()) return onOpen(result.conversationId); });

  /** One 56px row: avatar, name, and actions that stay out of the way. */
  function contactRow(contact, { actions = [] } = {}) {
    const row = socialNode("div", "", "collaboration-social-row"); row.dataset.userId = contact.userId;
    const name = identityName(contact);
    // The subtitle is the Lily ID alone. The relationship used to be printed
    // here too, but "friend" on every row in the friends list is noise.
    row.append(socialRowButton(name, contact.relationship === "friend" && !contact.ownBlocked ? () => openChat(contact) : null,
      { avatar: socialAvatar(name), subtitle: contact.lilyId || "" }));
    if (actions.length) {
      const controls = socialNode("div", "", "collaboration-social-actions");
      for (const control of actions) controls.append(control);
      row.append(controls);
    }
    return row;
  }

  function paintProfile(profile) {
    profileRow.replaceChildren();
    const name = identityName(profile || {});
    // Not a button: there is nothing to click here, and a disabled button
    // greys its own text — which made the reader's own name look inactive.
    const body = socialNode("div", "", "collaboration-row-open is-static");
    body.append(socialAvatar(name));
    const content = socialNode("div", "", "collaboration-row-content");
    content.append(socialNode("strong", name),
      socialNode("small", profile?.lilyId ? `${t("collaboration.social.myLilyId")}: ${profile.lilyId}` : t("collaboration.social.unavailable")));
    body.append(content);
    profileRow.append(body);
    // Your own Lily ID is how anyone adds you, so it has to be shareable. It
    // was plain text with no way to copy it.
    if (profile?.lilyId) {
      const actions = socialNode("div", "", "collaboration-social-actions is-persistent");
      const copy = socialIconButton("copy-lily-id", "copyId", "copy", async () => {
        try { await navigator.clipboard?.writeText(profile.lilyId); } catch { return; }
        const label = copy.getAttribute("aria-label");
        copy.dataset.copied = "1";
        copy.setAttribute("aria-label", t("collaboration.social.copied"));
        copy.title = t("collaboration.social.copied");
        // Restore the label so the button does not read "Copied" forever.
        setTimeout(() => {
          if (!copy.isConnected) return;
          copy.dataset.copied = "";
          copy.setAttribute("aria-label", label || "");
          copy.title = label || "";
        }, 1500);
      });
      actions.append(copy);
      profileRow.append(actions);
    }
  }

  function paintEntries(incoming) {
    entries.replaceChildren();
    // WeChat's "new friends" entry: pending requests are an errand with a
    // count, not rows to be spotted inside the contact list.
    const requestRow = socialNode("div", "", "collaboration-social-row is-entry");
    const button = socialRowButton(t("collaboration.social.newFriends"), () => { requestsOpen = !requestsOpen; paint(); },
      { icon: "request", trailing: incoming.length ? String(incoming.length) : "" });
    button.dataset.action = "new-friends";
    button.setAttribute("aria-expanded", String(requestsOpen));
    if (incoming.length) button.dataset.badge = "1";
    requestRow.append(button);
    entries.append(requestRow);
  }

  function paintRequests(incoming) {
    requestsPanel.replaceChildren();
    // With a detail view the requests are their own screen; without one (this
    // module rendered standalone, as the DOM tests do) they expand in place.
    const surface = requestsOpen && detail?.open ? detail.open(t("collaboration.social.newFriends")) : requestsPanel;
    requestsPanel.hidden = !requestsOpen || surface !== requestsPanel;
    if (!requestsOpen) { detail?.close?.(); return; }
    surface.replaceChildren();
    if (!incoming.length) { surface.append(socialNode("p", t("collaboration.social.noRequests"), "collaboration-empty")); return; }
    // Accept/decline stay as words here: this is the one screen where deciding
    // is the whole purpose, so the actions should not hide behind hover.
    for (const contact of incoming) {
      surface.append(contactRow(contact, { actions: [
        socialButton("accept", "accept", () => change("accept", contact)),
        socialButton("decline", "decline", () => change("decline", contact)),
      ] }));
    }
  }

  function matches(contact, needle) {
    if (!needle) return true;
    return [contact.displayName, contact.lilyId, contact.userId].some((value) => String(value || "").toLocaleLowerCase().includes(needle));
  }

  function paint() {
    const needle = filter.trim().toLocaleLowerCase();
    const all = Array.isArray(directoryCache.contacts) ? directoryCache.contacts : [];
    const incoming = all.filter((contact) => contact.relationship === "incoming" && !contact.ownBlocked);
    paintProfile(directoryCache.profile);
    paintEntries(incoming);
    paintRequests(incoming.filter((contact) => matches(contact, needle)));

    contacts.replaceChildren();
    const friends = all.filter((contact) => !contact.ownBlocked && contact.relationship !== "incoming" && matches(contact, needle));
    const blocked = all.filter((contact) => contact.ownBlocked && matches(contact, needle));
    if (!friends.length && !blocked.length) { contacts.append(socialNode("p", t("collaboration.noFriends"), "collaboration-empty")); return; }

    for (const section of groupByLetter(friends, (contact) => identityName(contact))) {
      const heading = socialNode("div", section.letter, "collaboration-section-letter");
      heading.dataset.letter = section.letter;
      contacts.append(heading);
      for (const contact of section.people) {
        contacts.append(contactRow(contact, { actions: [
          socialIconButton("chat", "chat", "chat", () => openChat(contact)),
          socialIconButton("remove", "remove", "remove", () => change("remove", contact), { tone: "danger" }),
          socialIconButton("block", "block", "block", () => change("block", contact), { tone: "danger" }),
        ] }));
      }
    }
    if (blocked.length) {
      const heading = socialNode("div", t("collaboration.social.blockedSection"), "collaboration-section-letter");
      heading.dataset.letter = "blocked";
      contacts.append(heading);
      for (const contact of blocked) {
        contacts.append(contactRow(contact, { actions: [socialButton("unblock", "unblock", () => change("unblock", contact))] }));
      }
    }
  }

  return {
    update({ directory, commands = [] } = {}) {
      directoryCache = directory || { contacts: [] };
      paint();
      ui.renderPending(commands, "friend", api);
    },
    setFilter(value) { filter = String(value || ""); paint(); },
    reset() {
      ui.reset(); lilyId.value = ""; clearLookup(); filter = ""; requestsOpen = false; detail?.close?.();
      directoryCache = { contacts: [] };
      profileRow.replaceChildren(); entries.replaceChildren(); requestsPanel.replaceChildren(); requestsPanel.hidden = true; contacts.replaceChildren();
    },
  };
}
