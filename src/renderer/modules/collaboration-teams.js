import { t } from "../i18n/index.js";
import { createSocialUi, socialNode, socialButton, socialIconButton, socialRowButton, socialField, socialPerson, selectedIds, socialAvatar, socialDisclosure, identityName } from "./collaboration-social-ui.js";

export function initCollaborationTeams(root, { api = window.assistantClient?.collaboration, onChanged = async () => {}, onOpen = () => {}, getNavigationGeneration = () => 0 } = {}) {
  if (!root?.querySelectorAll) return { update() {}, reset() {}, showConversation: async () => {} };
  root.replaceChildren();
  let directory = { contacts: [], teams: [] }, conversations = [], detailsGeneration = 0, detailsConversation = null, pendingDetailsId = "";
  const groupForm = socialNode("form", "", "collaboration-social-form"); groupForm.dataset.form = "group";
  groupForm.append(socialNode("h3", `${t("collaboration.social.createGroup")} · ${t("collaboration.scopePersonal")}`));
  const groupTitle = socialField(groupForm, "title", "name"); groupTitle.required = true;
  const groupMembers = socialField(groupForm, "members", "members", { multiple: true, options: [] });
  const createGroup = socialNode("button", t("collaboration.social.createGroup"), "collaboration-social-primary"); createGroup.type = "submit"; groupForm.append(createGroup);
  const list = socialNode("div"), personal = socialNode("div"), details = socialNode("div", "", "collaboration-member-details");
  root.append(socialDisclosure(`＋ ${t("collaboration.social.createGroup")}`, groupForm, { primary: true }), personal, list, details);
  const ui = createSocialUi(root, { onChanged, getNavigationGeneration });
  const optionsFor = (people) => people.map((p) => [p.userId, socialPerson(p)]);
  // `team:t_abc` is an internal addressing string. It used to be printed on
  // team headers and on every channel subtitle; a person has no use for it.
  const teamLabel = (team) => team.name;
  const scopeLabel = (scopeId) => scopeId === "personal" ? t("collaboration.scopePersonal") : teamLabel(directory.teams.find((team) => team.scopeId === scopeId) || { name: t("collaboration.scopeTeam"), scopeId });
  groupForm.addEventListener("submit", (event) => {
    event.preventDefault(); const title = groupTitle.value.trim(); if (!title) return;
    void ui.run(() => api.conversation({ action: "create", scopeType: "personal", kind: "group", title, memberUserIds: selectedIds(groupMembers) }), async (result, origin) => {
      if (groupTitle.value.trim() === title) groupTitle.value = "";
      if (result.conversationId && origin.isCurrentNavigation()) await onOpen(result.conversationId);
    });
  });
  /** `showScope` is false wherever the row already sits under a heading that
   *  names the scope: repeating "设计中心" on every channel of 设计中心 is the
   *  same words twice, and it is the widest thing on the row. */
  function conversationRow(conversation, { showScope = true } = {}) {
    const row = socialNode("div", "", "collaboration-social-row");
    const title = conversation.title || conversation.id;
    // Opening is the row itself; managing members is a hover/focus action, so
    // a list of channels reads as a list rather than as a grid of buttons.
    row.append(socialRowButton(title, () => onOpen(conversation.id), {
      avatar: socialAvatar(title, "chat"),
      subtitle: showScope ? scopeLabel(conversation.scopeId) : "",
    }));
    if (conversation.kind !== "direct") {
      const controls = socialNode("div", "", "collaboration-social-actions");
      controls.append(socialIconButton("members", "members", "people", () => controller.showConversation(conversation.id)));
      row.append(controls);
    }
    return row;
  }
  function channelForm(team) {
    const form = socialNode("form", "", "collaboration-social-form"); form.dataset.form = "channel";
    const title = socialField(form, "title", "name"); title.required = true;
    const visibility = socialField(form, "visibility", "visibility", { options: [["private", t("collaboration.social.private")],
      ...(["owner", "admin"].includes(team.role) ? [["public", t("collaboration.social.public")]] : [])] });
    const members = socialField(form, "members", "members", { multiple: true, options: optionsFor(team.members.filter((m) => m.userId !== directory.profile?.userId)) });
    visibility.addEventListener("change", () => { members.disabled = visibility.value === "public"; });
    const submit = socialNode("button", t("collaboration.social.createChannel"), "collaboration-social-primary"); submit.type = "submit"; form.append(submit);
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
    return socialDisclosure(`＋ ${t("collaboration.social.createChannel")}`, form);
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
      const personalGroups = conversations.filter((c) => c.scopeId === "personal" && c.kind === "group");
      if (personalGroups.length) {
        const heading = socialNode("div", t("collaboration.scopePersonal"), "collaboration-section-letter");
        heading.dataset.letter = "personal";
        personal.append(heading);
      }
      for (const conversation of personalGroups) personal.append(conversationRow(conversation, { showScope: false }));
      if (!directory.teams.length) list.append(socialNode("p", t("collaboration.social.noTeams"), "collaboration-empty"));
      for (const team of directory.teams) {
        const section = socialNode("section", "", "collaboration-team"); section.dataset.teamId = team.id;
        // The header is the team's own row: name plus a member count that is
        // the way IN to the roster. Every member used to be listed inline here,
        // which is unreadable for a team of any real size and buried the
        // channels — the thing people actually came to open — below them.
        const teamHeading = socialNode("header", "", "collaboration-team-header");
        const teamButton = socialRowButton(team.name, () => controller.showTeam(team.id), {
          avatar: socialAvatar(team.name, "team"),
          subtitle: t("collaboration.social.memberCount", { count: team.members.length }),
        });
        teamButton.dataset.action = "open-team";
        teamButton.dataset.teamId = team.id;
        teamHeading.append(teamButton);
        section.append(teamHeading);
        const channels = conversations.filter((c) => c.scopeId === team.scopeId);
        const channelList = socialNode("div", "", "collaboration-team-channels");
        if (!channels.length) channelList.append(socialNode("p", t("collaboration.social.noChannels"), "collaboration-empty"));
        for (const conversation of channels) channelList.append(conversationRow(conversation, { showScope: false }));
        section.append(channelList);
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
    /** The roster, on demand. Members are not list content: a team of any real
     *  size makes the channels unreachable if they are, and the permission
     *  checks that matter live on the conversation, not on the team. */
    showTeam(teamId) {
      detailsGeneration += 1; detailsConversation = null; pendingDetailsId = "";
      const team = directory.teams.find((entry) => entry.id === teamId);
      details.replaceChildren();
      if (!team) return;
      details.append(socialNode("h3", `${team.name} · ${t("collaboration.social.memberCount", { count: team.members.length })}`));
      for (const member of team.members) {
        const row = socialNode("div", "", "collaboration-social-row is-compact"); row.dataset.userId = member.userId;
        const name = identityName(member);
        row.append(socialRowButton(name, null, {
          avatar: socialAvatar(name),
          subtitle: t(`collaboration.social.role.${member.role || "member"}`),
        }));
        if (member.userId !== directory.profile?.userId) {
          const controls = socialNode("div", "", "collaboration-social-actions");
          controls.append(socialIconButton("team-chat", "teamChat", "chat", () => ui.run(
            () => api.conversation({ action: "create", scopeType: "organization", organizationId: team.id, kind: "direct", memberUserIds: [member.userId] }),
            (result, origin) => { if (origin.isCurrentNavigation()) return onOpen(result.conversationId); })));
          row.append(controls);
        }
        details.append(row);
      }
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
