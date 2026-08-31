import { t } from "../i18n/index.js";
import { createSocialUi, socialNode, socialButton, socialField, socialPerson, selectedIds } from "./collaboration-social-ui.js";

export function initCollaborationTeams(root, { api = window.assistantClient?.collaboration, onChanged = async () => {}, onOpen = () => {}, getNavigationGeneration = () => 0 } = {}) {
  if (!root?.querySelectorAll) return { update() {}, reset() {}, showConversation: async () => {} };
  root.replaceChildren();
  root.append(socialNode("p", t("collaboration.social.cachedDirectory"), "collaboration-status"));
  let directory = { contacts: [], teams: [] }, conversations = [], detailsGeneration = 0, detailsConversation = null, pendingDetailsId = "";
  const groupForm = socialNode("form", "", "collaboration-social-form"); groupForm.dataset.form = "group";
  groupForm.append(socialNode("h3", `${t("collaboration.social.createGroup")} · ${t("collaboration.scopePersonal")}`));
  const groupTitle = socialField(groupForm, "title", "name"); groupTitle.required = true;
  const groupMembers = socialField(groupForm, "members", "members", { multiple: true, options: [] });
  const createGroup = socialNode("button", t("collaboration.social.createGroup")); createGroup.type = "submit"; groupForm.append(createGroup);
  const list = socialNode("div"), personal = socialNode("div"), details = socialNode("div", "", "collaboration-member-details");
  root.append(groupForm, personal, list, details);
  const ui = createSocialUi(root, { onChanged, getNavigationGeneration });
  const optionsFor = (people) => people.map((p) => [p.userId, socialPerson(p)]);
  const teamLabel = (team) => `${team.name} · ${team.scopeId}`;
  const scopeLabel = (scopeId) => scopeId === "personal" ? t("collaboration.scopePersonal") : teamLabel(directory.teams.find((team) => team.scopeId === scopeId) || { name: t("collaboration.scopeTeam"), scopeId });
  groupForm.addEventListener("submit", (event) => {
    event.preventDefault(); const title = groupTitle.value.trim(); if (!title) return;
    void ui.run(() => api.conversation({ action: "create", scopeType: "personal", kind: "group", title, memberUserIds: selectedIds(groupMembers) }), async (result, origin) => {
      if (groupTitle.value.trim() === title) groupTitle.value = "";
      if (result.conversationId && origin.isCurrentNavigation()) await onOpen(result.conversationId);
    });
  });
  function conversationRow(conversation) {
    const row = socialNode("div", "", "collaboration-social-row");
    row.append(socialNode("p", `${conversation.title || conversation.id} · ${scopeLabel(conversation.scopeId)}`));
    row.append(socialButton("open-conversation", "chat", () => onOpen(conversation.id)));
    if (conversation.kind !== "direct") row.append(socialButton("members", "members", () => controller.showConversation(conversation.id)));
    return row;
  }
  function channelForm(team) {
    const form = socialNode("form", "", "collaboration-social-form"); form.dataset.form = "channel";
    const title = socialField(form, "title", "name"); title.required = true;
    const visibility = socialField(form, "visibility", "visibility", { options: [["private", t("collaboration.social.private")],
      ...(["owner", "admin"].includes(team.role) ? [["public", t("collaboration.social.public")]] : [])] });
    const members = socialField(form, "members", "members", { multiple: true, options: optionsFor(team.members.filter((m) => m.userId !== directory.profile?.userId)) });
    visibility.addEventListener("change", () => { members.disabled = visibility.value === "public"; });
    const submit = socialNode("button", t("collaboration.social.createChannel")); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault(); const value = title.value.trim(); if (!value) return;
      const kind = visibility.value;
      void ui.run(() => api.conversation({ action: "create", scopeType: "organization", organizationId: team.id, kind: "channel", visibility: kind, title: value,
        memberUserIds: kind === "public" ? [] : selectedIds(members) }), async (result, origin) => {
        const current = [...list.querySelectorAll("[data-team-id]")].find((node) => node.dataset.teamId === team.id)?.querySelector('[name="title"]');
        if (current?.value.trim() === value) current.value = "";
        if (result.conversationId && origin.isCurrentNavigation()) await onOpen(result.conversationId);
      });
    });
    return form;
  }
  async function memberChange(conversation, target, operation, role) {
    const generation = ui.current();
    if (operation !== "add" && !await ui.confirm("confirmMemberChange", `${socialPerson(target)} · ${conversation.title || conversation.id} · ${scopeLabel(conversation.scopeId)}`)) return;
    if (generation !== ui.current()) return;
    await ui.run(() => api.conversation({ action: "member", conversationId: conversation.id, targetUserId: target.userId, operation, ...(role ? { role } : {}) }), (_result, origin) => { if (origin.isCurrentNavigation()) return controller.showConversation(conversation.id); });
  }
  function renderDetails(result) {
    details.replaceChildren();
    const conversation = result.conversation;
    details.append(socialNode("h3", `${conversation.title || conversation.id} · ${scopeLabel(conversation.scopeId)}`));
    for (const member of result.members) {
      const row = socialNode("div", "", "collaboration-social-row"); row.dataset.userId = member.userId;
      row.append(socialNode("p", `${socialPerson(member)} · ${t(`collaboration.social.role.${member.role}`)}`));
      if (result.canManage && member.role !== "owner") {
        row.append(socialButton("remove-member", "removeMember", () => memberChange(conversation, member, "remove")));
        row.append(socialButton("role-member", member.role === "admin" ? "makeMember" : "makeAdmin", () => memberChange(conversation, member, "role", member.role === "admin" ? "member" : "admin")));
      }
      details.append(row);
    }
    if (result.canManage) {
      const available = conversation.scopeId === "personal" ? directory.contacts.filter((c) => c.relationship === "friend" && !c.ownBlocked)
        : directory.teams.find((team) => team.scopeId === conversation.scopeId)?.members || [];
      const candidates = available.filter((p) => !result.members.some((m) => m.userId === p.userId));
      if (candidates.length) {
        const form = socialNode("form", "", "collaboration-social-form");
        const target = socialField(form, "targetUserId", "members", { options: optionsFor(candidates) });
        const add = socialNode("button", t("collaboration.social.addMember")); add.type = "submit"; form.append(add);
        form.addEventListener("submit", (event) => { event.preventDefault(); const person = candidates.find((p) => p.userId === target.value); if (person) void memberChange(conversation, person, "add"); });
        details.append(form);
      }
    } else details.append(socialNode("p", t(result.visibility === "public" ? "collaboration.social.publicMembership" : "collaboration.social.readOnlyMembers")));
  }
  const controller = {
    update({ directory: nextDirectory, conversations: nextConversations = [], commands = [] } = {}) {
      directory = nextDirectory || { contacts: [], teams: [] }; conversations = nextConversations;
      if (pendingDetailsId && !conversations.some((c) => c.id === pendingDetailsId) || detailsConversation && (!conversations.some((c) => c.id === detailsConversation.id)
        || detailsConversation.scopeId.startsWith("team:") && !directory.teams.some((team) => team.scopeId === detailsConversation.scopeId))) {
        detailsGeneration += 1; detailsConversation = null; pendingDetailsId = ""; details.replaceChildren(); ui.reset();
      }
      const selected = new Set(selectedIds(groupMembers));
      groupMembers.replaceChildren();
      for (const [value, label] of optionsFor(directory.contacts.filter((c) => c.relationship === "friend" && !c.ownBlocked))) {
        const option = socialNode("option", label); option.value = value; option.selected = selected.has(value); groupMembers.append(option);
      }
      // Normal sync must not erase unfinished channel forms. Retain exact IDs,
      // and restore selections only if they still exist in the current roster.
      const drafts = new Map([...list.querySelectorAll("[data-team-id]")].map((node) => [node.dataset.teamId,
        [...node.querySelectorAll("input,select")].map((field) => ({ name: field.name, value: field.value, selected: field.multiple ? selectedIds(field) : null }))]));
      list.replaceChildren(); personal.replaceChildren();
      for (const conversation of conversations.filter((c) => c.scopeId === "personal" && c.kind === "group")) personal.append(conversationRow(conversation));
      if (!directory.teams.length) list.append(socialNode("p", t("collaboration.social.noTeams"), "collaboration-empty"));
      for (const team of directory.teams) {
        const section = socialNode("section", "", "collaboration-team"); section.dataset.teamId = team.id;
        section.append(socialNode("h3", teamLabel(team)));
        for (const member of team.members) {
          const row = socialNode("div", socialPerson(member), "collaboration-social-row");
          if (member.userId !== directory.profile?.userId) row.append(socialButton("team-chat", "teamChat", () => ui.run(() => api.conversation({ action: "create", scopeType: "organization", organizationId: team.id, kind: "direct", memberUserIds: [member.userId] }), (result, origin) => { if (origin.isCurrentNavigation()) return onOpen(result.conversationId); })));
          section.append(row);
        }
        for (const conversation of conversations.filter((c) => c.scopeId === team.scopeId)) section.append(conversationRow(conversation));
        section.append(channelForm(team)); list.append(section);
        for (const field of section.querySelectorAll("input,select")) {
          const draft = drafts.get(team.id)?.find((entry) => entry.name === field.name); if (!draft) continue;
          if (field.multiple) for (const option of field.options) option.selected = draft.selected?.includes(option.value);
          else if (field.tagName !== "SELECT" || [...field.options].some((o) => o.value === draft.value)) field.value = draft.value;
        }
        const visibility = section.querySelector('[name="visibility"]'); section.querySelector('[name="members"]').disabled = visibility.value === "public";
      }
      ui.renderPending(commands, "conversation", api, scopeLabel);
    },
    async showConversation(conversationId) {
      const generation = ++detailsGeneration, epoch = ui.current();
      pendingDetailsId = conversationId;
      details.replaceChildren(socialNode("p", t("collaboration.social.loading")));
      const result = await Promise.resolve(api.getConversationDetails(conversationId)).catch(() => null);
      if (generation !== detailsGeneration || epoch !== ui.current()) return;
      pendingDetailsId = "";
      if (!result?.ok) { details.replaceChildren(socialNode("p", t("collaboration.social.permissionUnavailable"))); return; }
      detailsConversation = result.conversation;
      renderDetails(result);
    },
    reset() { detailsGeneration += 1; detailsConversation = null; pendingDetailsId = ""; ui.reset(); directory = { contacts: [], teams: [] }; conversations = []; groupTitle.value = ""; groupMembers.replaceChildren(); list.replaceChildren(); personal.replaceChildren(); details.replaceChildren(); },
  };
  return controller;
}
