import { t } from "../i18n/index.js";
import { createSocialUi, socialNode, socialButton, socialField, socialPerson, socialAvatar, socialDisclosure } from "./collaboration-social-ui.js";

export function renderCollaborationFriends(node, relationships = []) {
  if (!node) return;
  node.replaceChildren();
  const rows = Array.isArray(relationships) ? relationships : [];
  if (rows.length === 0) { const empty = document.createElement("p"); empty.className = "collaboration-empty"; empty.textContent = t("collaboration.noFriends"); node.append(empty); return; }
  for (const relationship of rows) { const row = document.createElement("p"); row.textContent = String(relationship.displayName || relationship.peerUserId || ""); node.append(row); }
}

export function initCollaborationFriends(root, { api = window.assistantClient?.collaboration, onChanged = async () => {}, onOpen = () => {}, getNavigationGeneration = () => 0 } = {}) {
  if (!root?.querySelectorAll) return { update() {}, reset() {} };
  root.replaceChildren();
  const profile = socialNode("p", "", "collaboration-profile-id"); root.append(profile);
  const form = socialNode("form", "", "collaboration-social-form");
  const lilyId = socialField(form, "lilyId", "exactLilyId"); lilyId.required = true; lilyId.maxLength = 64;
  const submit = socialNode("button", t("collaboration.social.request"), "collaboration-social-primary"); submit.type = "submit"; form.append(submit); root.append(socialDisclosure(`＋ ${t("collaboration.social.request")}`, form, { primary: true }));
  const contacts = socialNode("div"); root.append(contacts);
  const ui = createSocialUi(root, { onChanged, getNavigationGeneration });
  form.addEventListener("submit", (event) => {
    event.preventDefault(); const value = lilyId.value.trim(); if (!value) return;
    void ui.run(() => api.friend({ action: "request", lilyId: value }), () => { if (lilyId.value.trim() === value) lilyId.value = ""; });
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
  return {
    update({ directory, commands = [] } = {}) {
      profile.textContent = `${t("collaboration.social.myLilyId")}: ${directory?.profile?.lilyId || t("collaboration.social.unavailable")}`;
      contacts.replaceChildren();
      const rows = directory?.contacts || [];
      if (!rows.length) contacts.append(socialNode("p", t("collaboration.noFriends"), "collaboration-empty"));
      for (const contact of rows) {
        const row = socialNode("section", "", "collaboration-social-row"); row.dataset.userId = contact.userId;
        const name = contact.displayName || contact.lilyId || contact.userId;
        const copy = socialNode("div", "", "collaboration-row-content"); copy.append(socialNode("strong", name), socialNode("small", `${contact.lilyId || contact.userId} · ${t(`collaboration.social.${contact.ownBlocked ? "blocked" : contact.relationship || "contact"}`)}`));
        row.append(socialAvatar(name), copy);
        const controls = socialNode("div", "", "collaboration-social-actions");
        if (contact.ownBlocked) controls.append(socialButton("unblock", "unblock", () => change("unblock", contact)));
        else {
          if (contact.relationship === "incoming") for (const action of ["accept", "decline"]) controls.append(socialButton(action, action, () => change(action, contact)));
          if (contact.relationship === "friend") {
            controls.append(socialButton("chat", "chat", () => ui.run(() => api.openFriend(contact.userId), (result, origin) => { if (origin.isCurrentNavigation()) return onOpen(result.conversationId); })));
            controls.append(socialButton("remove", "remove", () => change("remove", contact)));
          }
          controls.append(socialButton("block", "block", () => change("block", contact)));
        }
        row.append(controls); contacts.append(row);
      }
      ui.renderPending(commands, "friend", api);
    },
    reset() { ui.reset(); lilyId.value = ""; profile.textContent = ""; contacts.replaceChildren(); },
  };
}
