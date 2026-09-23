import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { AdminEmpty } from "../../../../../components/admin-empty";
import { ConfigProfileForm } from "../../../../../components/config-profile-form";
import { loadAdmin } from "../../../../../lib/api";
import { getI18n } from "../../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

// Edit starts from the saved rule: the form is seeded with it, and saving
// writes back to the same id (the API's upsert records a revision, so the
// previous version stays one rollback away).
export default async function EditConfigProfilePage({ params }) {
  const { id } = await params;
  const { t } = await getI18n();
  const c = t.admin.configProfiles;
  const [profileData, providersData, skillsData, agentsData, mediaData] = await Promise.all([
    loadAdmin(`/api/admin/config-profiles/${encodeURIComponent(id)}`, null),
    loadAdmin("/api/admin/model-providers", { providers: [] }),
    loadAdmin("/api/admin/skill-packages", { skillPackages: [] }),
    loadAdmin("/api/admin/agent-packages", { agentPackages: [] }),
    loadAdmin("/api/admin/media-providers", { mediaProviders: [] }),
  ]);
  const skillPackageOptions = [
    ...new Map((skillsData.skillPackages || []).map((s) => [String(s.skill_id || ""), { id: String(s.skill_id || ""), label: String(s.name || s.skill_id || "") }])).values(),
  ].filter((o) => o.id);
  // One option per agentId; the API returns newest rows first, so the first row
  // seen wins and the label carries the current definition's name.
  const agentPackageOptions = [];
  const seenAgentIds = new Set();
  for (const a of agentsData.agentPackages || []) {
    const id = String(a?.agent_id || "");
    if (!id || a.enabled === false || seenAgentIds.has(id)) continue;
    seenAgentIds.add(id);
    const definition = a.definition && typeof a.definition === "object" ? a.definition : {};
    agentPackageOptions.push({ id, label: definition.name ? `${definition.name} (${id})` : id });
  }

  const profile = profileData?.profile;
  if (!profile) {
    return (
      <AdminShell title={c.editMissingTitle} subtitle={id}>
        <AdminEmpty title={c.editMissingTitle} description={c.editMissingDesc} />
      </AdminShell>
    );
  }
  return (
    <AdminShell title={`${c.edit} · ${profile.name || profile.id}`} subtitle={c.editSubtitle}>
      <div className="mb-5">
        <Link href="/admin/config/profiles" className="text-sm font-semibold text-brand">{c.back}</Link>
      </div>
      <ConfigProfileForm providers={providersData.gateway || []} skillPackageOptions={skillPackageOptions} agentPackageOptions={agentPackageOptions} mediaProviders={mediaData.mediaProviders || []} profile={profile} />
    </AdminShell>
  );
}
