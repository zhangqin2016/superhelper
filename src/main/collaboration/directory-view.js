"use strict";

const { profile, id, rows, role, text } = require("./directory-projection");
function invalid() { throw Object.assign(new Error("Collaboration directory is invalid"), { code: "COLLAB_DIRECTORY_INVALID" }); }
function unique(values) { if (new Set(values).size !== values.length) invalid(); }

/** A closed, read-only view contract; never spread store/transport objects. */
function directoryView(value) {
  if (!value || !Array.isArray(value.contacts) || !Array.isArray(value.teams)) invalid();
  const contacts = rows(value.contacts).map((contact) => {
    if (!contact || ![null, "friend", "incoming", "outgoing"].includes(contact.relationship) || typeof contact.ownBlocked !== "boolean") invalid();
    const pending = ["incoming", "outgoing"].includes(contact.relationship);
    if (!pending && contact.requestId != null || contact.relationship === null && !contact.ownBlocked) invalid();
    return { ...profile(contact), relationship: contact.relationship, requestId: pending ? id(contact.requestId) : null, ownBlocked: contact.ownBlocked };
  });
  unique(contacts.map((c) => c.userId));
  const teams = rows(value.teams).map((team) => {
    const teamId = id(team?.id);
    if (team.scopeId !== `team:${teamId}` || !Array.isArray(team.members)) invalid();
    const members = rows(team.members).map((member) => ({ ...profile(member), role: role(member.role), ...(member.presence == null ? {} : { presence: ["online", "offline", "unknown"].includes(member.presence) ? member.presence : "unknown", onlineUntil: Number.isFinite(Date.parse(member.onlineUntil)) ? member.onlineUntil : null }) }));
    unique(members.map((m) => m.userId));
    return { id: teamId, scopeId: team.scopeId, name: text(team.name), role: role(team.role), members };
  });
  unique(teams.map((t) => t.id));
  return { ...(value.directorySource === "live" || value.directorySource === "cached" ? { directorySource: value.directorySource } : {}), profile: value.profile == null ? null : profile(value.profile), contacts, teams };
}

module.exports = { directoryView };
