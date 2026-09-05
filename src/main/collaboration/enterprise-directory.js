"use strict";
function createEnterpriseDirectoryReader({ client, deviceId, assertActive = () => {}, now = () => Date.now() }) {
  let cached = null, refreshedAt = -Infinity, pending = null, localVersion = "";
  return async function read(local) {
    if (!client?.getEnterpriseDirectory) return local;
    const version = JSON.stringify(local.teams.map(t => [t.id, t.role, t.members.map(m => [m.userId, m.role])]));
    if (version !== localVersion) { localVersion = version; refreshedAt = -Infinity; }
    if (!pending && now() - refreshedAt >= 10000) {
      pending = client.getEnterpriseDirectory({ deviceId }).then(value => {
        assertActive();
        if (!value || !Array.isArray(value.teams)) throw new Error("Invalid enterprise directory");
        // Older servers answer without loginName/phoneMasked; keep what the
        // bootstrap already stored locally rather than blanking the display.
        const known = new Map(local.teams.flatMap(t => t.members.map(m => [m.userId, m])));
        const keepFacets = (member) => ({ ...member,
          loginName: member.loginName || known.get(member.userId)?.loginName || "",
          phoneMasked: member.phoneMasked || known.get(member.userId)?.phoneMasked || "" });
        const teams = value.teams.map(team => ({ ...team, members: Array.isArray(team.members) ? team.members.map(keepFacets) : team.members }));
        const profile = value.profile ? { ...value.profile, loginName: value.profile.loginName || local.profile?.loginName || "", phoneMasked: value.profile.phoneMasked || local.profile?.phoneMasked || "" } : value.profile;
        cached = { ...local, profile, teams, directorySource: "live" };
        refreshedAt = now();
      }).catch(error => {
        assertActive();
        // Authorization failure removes enterprise visibility. An unavailable
        // transport retains baseline directory content but never stale online.
        const denied = /SESSION|ACCOUNT|REVOKED|DENIED|UNAUTHORIZED/.test(String(error?.code || ""));
        const baseline = cached || local;
        cached = { ...baseline, teams: denied ? [] : baseline.teams.map(t => ({ ...t, members: t.members.map(m => ({ ...m, presence: "unknown", onlineUntil: null })) })), directorySource: "cached" };
        refreshedAt = now();
      }).finally(() => { pending = null; });
    }
    if (pending) await pending;
    assertActive();
    if (!cached) return local;
    const profiles = new Map(cached.teams.flatMap(team => team.members.map(member => [member.userId, member])));
    const contacts = local.contacts.map(contact => {
      const fresh = profiles.get(contact.userId);
      return fresh ? { ...contact, displayName: fresh.displayName, lilyId: fresh.lilyId, avatarObjectId: fresh.avatarObjectId,
        loginName: fresh.loginName || contact.loginName || "", phoneMasked: fresh.phoneMasked || contact.phoneMasked || "" } : contact;
    });
    return { ...cached, contacts };
  };
}
module.exports = { createEnterpriseDirectoryReader };
