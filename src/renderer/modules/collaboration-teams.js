import { t } from "../i18n/index.js";
import { createSocialUi, socialNode, socialButton, socialIconButton, socialRowButton, socialField, socialPerson, socialAvatar, socialDisclosure, identityName } from "./collaboration-social-ui.js";
import { createMemberPicker, derivedGroupTitle } from "./member-picker.js";

export function initCollaborationTeams(root, { api = window.assistantClient?.collaboration, onChanged = async () => {}, onOpen = () => {}, getNavigationGeneration = () => 0, detail = null, drawer = null } = {}) {
  if (!root?.querySelectorAll) return { update() {}, reset() {}, showConversation: async () => {} };
  root.replaceChildren();
  let directory = { contacts: [], teams: [] }, conversations = [], detailsGeneration = 0, detailsConversation = null, pendingDetailsId = "";
  // Live channel-member pickers by team id. The team sections are rebuilt on
  // every sync, so an unfinished selection has to be snapshotted and restored
  // the same way the text fields already are.
  const channelPickers = new Map();
  const groupForm = socialNode("form", "", "collaboration-social-form"); groupForm.dataset.form = "group";
  // No heading: the disclosure that opens this form already carries the same
  // words, and printing them twice is the redundancy removed elsewhere here.
  // Members first, name second and optional. It was the other way round, with
  // the name REQUIRED, so a group had to be named before anyone was chosen —
  // and the server never required a title in the first place.
  const groupMembers = createMemberPicker({ minimum: 1, onChange: () => refreshGroupSubmit() });
  groupForm.append(groupMembers.node);
  const groupTitle = socialField(groupForm, "title", "groupNameHint");
  groupTitle.maxLength = 200;
  const createGroup = socialNode("button", t("collaboration.social.done"), "collaboration-social-primary"); createGroup.type = "submit"; groupForm.append(createGroup);
  // A "group" containing nobody but yourself is not a group, and a one-to-one
  // conversation is already `direct`. The server imposes no minimum, so this is
  // the client saying what the word means.
  function refreshGroupSubmit() {
    const count = groupMembers.count();
    createGroup.textContent = count ? `${t("collaboration.social.done")} (${count})` : t("collaboration.social.done");
    createGroup.disabled = !groupMembers.satisfied();
    createGroup.title = groupMembers.satisfied() ? "" : t("collaboration.social.needMembers");
  }
  refreshGroupSubmit();
  const list = socialNode("div"), personal = socialNode("div"), details = socialNode("div", "", "collaboration-member-details");
  /** Where a roster is drawn. With a detail view it is its own screen beside
   *  the list; without one (this module rendered standalone, as the DOM tests
   *  do) it falls back to the inline container it always used. */
  // Which surface a roster is drawn on: the drawer when opened from a
  // conversation (WeChat's group info), otherwise the list-column detail.
  let rosterSurface = "detail";
  const activeSurface = () => (rosterSurface === "drawer" ? drawer : detail);
  const detailSurface = (title) => activeSurface()?.open?.(title) || details;
  const closeDetailSurface = () => { detail?.close?.(); drawer?.close?.(); details.replaceChildren(); };
  // The create entry lines up with the avatar column, like the other entries,
  // instead of floating above the section headings as a text link.
  const createGroupEntry = socialDisclosure(t("collaboration.social.createGroup"), groupForm, { primary: true, icon: "people" });
  createGroupEntry.classList.add("is-row", "is-entry-row");
  root.append(createGroupEntry, personal, list, details);
  const ui = createSocialUi(root, { onChanged, getNavigationGeneration });
  // `team:t_abc` is an internal addressing string. It used to be printed on
  // team headers and on every channel subtitle; a person has no use for it.
  const teamLabel = (team) => team.name;
  const scopeLabel = (scopeId) => scopeId === "personal" ? t("collaboration.scopePersonal") : teamLabel(directory.teams.find((team) => team.scopeId === scopeId) || { name: t("collaboration.scopeTeam"), scopeId });
  groupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!groupMembers.satisfied()) return;
    const memberUserIds = groupMembers.selectedIds();
    // Blank means "name it after the people in it", the way every chat client
    // does; the previous form refused to submit without a typed name.
    const title = groupTitle.value.trim() || derivedGroupTitle(groupMembers.selectedNames());
    void ui.run(() => api.conversation({ action: "create", scopeType: "personal", kind: "group", title, memberUserIds }), async (result, origin) => {
      if (groupTitle.value.trim() === title) groupTitle.value = "";
      groupMembers.reset();
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
    // A channel may legitimately start with nobody but its creator, so unlike
    // a personal group there is no minimum here.
    const members = createMemberPicker({ minimum: 0 });
    members.setPeople(team.members.filter((m) => m.userId !== directory.profile?.userId));
    form.append(members.node);
    channelPickers.set(team.id, members);
    // A public channel's membership IS the team, so the picker is HIDDEN rather
    // than disabled: a greyed-out list of names you cannot act on is noise, and
    // it implied the choice still mattered.
    const syncVisibility = () => {
      const isPublic = visibility.value === "public";
      members.node.hidden = isPublic;
      publicNote.hidden = !isPublic;
    };
    const publicNote = socialNode("p", t("collaboration.social.publicMembership"), "collaboration-form-note");
    form.append(publicNote);
    visibility.addEventListener("change", syncVisibility);
    syncVisibility();
    const submit = socialNode("button", t("collaboration.social.createChannel"), "collaboration-social-primary"); submit.type = "submit"; form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault(); const value = title.value.trim(); if (!value) return;
      const kind = visibility.value;
      void ui.run(() => api.conversation({ action: "create", scopeType: "organization", organizationId: team.id, kind: "channel", visibility: kind, title: value,
        memberUserIds: kind === "public" ? [] : members.selectedIds() }), async (result, origin) => {
        const current = [...list.querySelectorAll("section.collaboration-team[data-team-id]")].find((node) => node.dataset.teamId === team.id)?.querySelector('[name="title"]');
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
  // Leaving removes yourself; dissolving (owner only) removes the group for
  // everyone. Both drop the conversation locally once projected, so the detail
  // surface closes and the lists reload rather than showing a dead roster.
  async function leaveGroup(conversation, selfUserId) {
    if (!await ui.confirm("confirmLeaveGroup", conversation.title || conversation.id)) return;
    await ui.run(() => api.conversation({ action: "member", conversationId: conversation.id, targetUserId: selfUserId, operation: "remove" }), (_result, origin) => { if (origin.isCurrentNavigation()) closeDetailSurface(); });
  }
  async function dissolveGroup(conversation) {
    if (!await ui.confirm("confirmDissolveGroup", conversation.title || conversation.id)) return;
    await ui.run(() => api.conversation({ action: "dissolve", conversationId: conversation.id }), (_result, origin) => { if (origin.isCurrentNavigation()) closeDetailSurface(); });
  }
  function renderDetails(result) {
    const conversation = result.conversation;
    // The detail view's own header names it; an <h3> here was a third title
    // stacked inside the list.
    const heading = conversation.title || conversation.id;
    const surface = detailSurface(rosterSurface === "drawer" ? heading : `${heading} · ${scopeLabel(conversation.scopeId)}`);
    surface.replaceChildren();
    if (surface === details) details.append(socialNode("h3", `${conversation.title || conversation.id} · ${scopeLabel(conversation.scopeId)}`));
    for (const member of result.members) {
      const row = socialNode("div", "", "collaboration-social-row is-compact"); row.dataset.userId = member.userId;
      const memberName = identityName(member);
      const memberBody = socialRowButton(memberName, null, {
        avatar: socialAvatar(memberName),
        subtitle: member.lilyId ? `${member.lilyId} · ${t(`collaboration.social.role.${member.role}`)}` : t(`collaboration.social.role.${member.role}`),
      });
      memberBody.classList.add("is-static");
      memberBody.disabled = false;
      row.append(memberBody);
      if (result.canManage && member.role !== "owner") {
        row.append(socialButton("remove-member", "removeMember", () => memberChange(conversation, member, "remove")));
        row.append(socialButton("role-member", member.role === "admin" ? "makeMember" : "makeAdmin", () => memberChange(conversation, member, "role", member.role === "admin" ? "member" : "admin")));
      }
      surface.append(row);
    }
    if (result.canManage) {
      const available = conversation.scopeId === "personal" ? directory.contacts.filter((c) => c.relationship === "friend" && !c.ownBlocked)
        : directory.teams.find((team) => team.scopeId === conversation.scopeId)?.members || [];
      const candidates = available.filter((p) => !result.members.some((m) => m.userId === p.userId));
      if (candidates.length) {
        const form = socialNode("form", "", "collaboration-social-form");
        // Single-select on purpose: `conversation.member` takes ONE target per
        // call, so a multi-select would promise a batch the command layer
        // cannot deliver — and a partly-applied batch (three added, then
        // denied) has no story here. Searchable and with avatars either way,
        // which a bare <select> of names was not.
        // The submit button is created FIRST: `setPeople` paints synchronously
        // and that calls onChange, which touches `add` — declared after the
        // picker it crashed on a temporal-dead-zone error, so the add form
        // never rendered whenever there was anyone to add.
        const add = socialNode("button", t("collaboration.social.addMember"), "collaboration-social-primary"); add.type = "submit";
        add.disabled = true;
        const target = createMemberPicker({ minimum: 1, single: true, onChange: () => { add.disabled = !target.satisfied(); } });
        target.setPeople(candidates);
        form.append(target.node, add);
        // WeChat puts an add tile in the grid itself; this one reveals the form
        // below and puts the cursor in its search box.
        const addTile = socialNode("button", "", "collaboration-social-row is-add-tile");
        addTile.type = "button";
        addTile.dataset.action = "add-member-tile";
        addTile.setAttribute("aria-label", t("collaboration.addMemberTile"));
        const plus = socialNode("span", "＋", "collaboration-row-avatar is-add");
        plus.setAttribute("aria-hidden", "true");
        addTile.append(plus, socialNode("small", t("collaboration.addMemberTile")));
        addTile.addEventListener("click", () => { form.scrollIntoView?.({ block: "nearest" }); form.querySelector("input,select")?.focus?.(); });
        surface.append(addTile);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const [userId] = target.selectedIds();
          const person = candidates.find((p) => p.userId === userId);
          if (person) void memberChange(conversation, person, "add");
        });
        surface.append(form);
      }
    } else surface.append(socialNode("p", t(result.visibility === "public" ? "collaboration.social.publicMembership" : "collaboration.social.readOnlyMembers")));
    // WeChat-style bottom action: the owner dissolves the group, everyone else
    // leaves it. `result.self` is authoritative (it always includes my role),
    // so this does not depend on the Teams tab having loaded my profile.
    const self = result.self;
    if (self && conversation.kind !== "direct" && result.visibility !== "public") {
      const danger = socialNode("div", "", "collaboration-member-danger");
      danger.append(self.role === "owner"
        ? socialButton("dissolve-group", "dissolveGroup", () => dissolveGroup(conversation))
        : socialButton("leave-group", "leaveGroup", () => leaveGroup(conversation, self.userId)));
      surface.append(danger);
    }
  }
  const controller = {
    update({ directory: nextDirectory, conversations: nextConversations = [], commands = [] } = {}) {
      directory = nextDirectory || { contacts: [], teams: [] }; conversations = nextConversations;
      if (pendingDetailsId && !conversations.some((c) => c.id === pendingDetailsId) || detailsConversation && (!conversations.some((c) => c.id === detailsConversation.id)
        || detailsConversation.scopeId.startsWith("team:") && !directory.teams.some((team) => team.scopeId === detailsConversation.scopeId))) {
        detailsGeneration += 1; detailsConversation = null; pendingDetailsId = ""; closeDetailSurface(); ui.reset();
      }
      // The picker keeps its own selection across a roster refresh, dropping
      // only people who are no longer selectable. A blocked or removed contact
      // therefore cannot stay silently selected.
      groupMembers.setPeople(directory.contacts.filter((c) => c.relationship === "friend" && !c.ownBlocked));
      // Normal sync must not erase unfinished channel forms. Retain exact IDs,
      // and restore selections only if they still exist in the current roster.
      const drafts = new Map([...list.querySelectorAll("section.collaboration-team[data-team-id]")].map((node) => [node.dataset.teamId,
        // The picker's own search box and checkboxes are excluded: they are not
        // named form fields, and restoring `value` onto a checkbox would tick
        // the wrong people. The picker's selection is snapshotted separately.
        [...node.querySelectorAll("input,select")]
          .filter((field) => field.name && !field.closest(".collaboration-member-picker"))
          .map((field) => ({ name: field.name, value: field.value }))]));
      const channelSelections = new Map([...channelPickers].map(([teamId, picker]) => [teamId, picker.snapshot()]));
      channelPickers.clear();
      list.replaceChildren(); personal.replaceChildren();
      const personalGroups = conversations.filter((c) => c.scopeId === "personal" && c.kind === "group");
      if (personalGroups.length) {
        const heading = socialNode("div", t("collaboration.scopePersonal"), "collaboration-section-letter");
        heading.dataset.letter = "personal";
        personal.append(heading);
      }
      for (const conversation of personalGroups) personal.append(conversationRow(conversation, { showScope: false }));
      // A heading for the teams block, matching the personal one. Without it
      // the "no teams yet" message sat directly under the personal groups and
      // read as if it described that list.
      const teamsHeading = socialNode("div", t("collaboration.teams"), "collaboration-section-letter");
      teamsHeading.dataset.letter = "teams";
      list.append(teamsHeading);
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
          if (!field.name || field.closest(".collaboration-member-picker")) continue;
          const draft = drafts.get(team.id)?.find((entry) => entry.name === field.name); if (!draft) continue;
          if (field.tagName !== "SELECT" || [...field.options].some((o) => o.value === draft.value)) field.value = draft.value;
        }
        // Restore the picked members, then re-apply the public/private state —
        // in that order, because a restored "public" visibility has to hide the
        // picker again after its selection has been put back.
        channelPickers.get(team.id)?.restore(channelSelections.get(team.id));
        section.querySelector('[name="visibility"]')?.dispatchEvent(new Event("change"));
      }
      ui.renderPending(commands, "conversation", api, scopeLabel);
    },
    /** The roster, on demand. Members are not list content: a team of any real
     *  size makes the channels unreachable if they are, and the permission
     *  checks that matter live on the conversation, not on the team. */
    showTeam(teamId) {
      detailsGeneration += 1; detailsConversation = null; pendingDetailsId = "";
      const team = directory.teams.find((entry) => entry.id === teamId);
      if (!team) { closeDetailSurface(); return; }
      const surface = detailSurface(`${team.name} · ${t("collaboration.social.memberCount", { count: team.members.length })}`);
      surface.replaceChildren();
      if (surface === details) details.append(socialNode("h3", `${team.name} · ${t("collaboration.social.memberCount", { count: team.members.length })}`));
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
        surface.append(row);
      }
    },
    async showConversation(conversationId, { surface = "detail" } = {}) {
      rosterSurface = drawer && surface === "drawer" ? "drawer" : "detail";
      const generation = ++detailsGeneration, epoch = ui.current();
      pendingDetailsId = conversationId;
      detailSurface(t("collaboration.social.loading")).replaceChildren(socialNode("p", t("collaboration.social.loading")));
      const result = await Promise.resolve(api.getConversationDetails(conversationId)).catch(() => null);
      if (generation !== detailsGeneration || epoch !== ui.current()) return;
      pendingDetailsId = "";
      if (!result?.ok) { detailSurface(t("collaboration.social.permissionUnavailable")).replaceChildren(socialNode("p", t("collaboration.social.permissionUnavailable"))); return; }
      detailsConversation = result.conversation;
      renderDetails(result);
    },
    reset() { detailsGeneration += 1; detailsConversation = null; pendingDetailsId = ""; ui.reset(); directory = { contacts: [], teams: [] }; conversations = []; groupTitle.value = ""; groupMembers.setPeople([]); groupMembers.reset(); list.replaceChildren(); personal.replaceChildren(); closeDetailSurface(); },
  };
  return controller;
}
