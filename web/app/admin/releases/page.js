import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { AdminPageActions } from "../../../components/admin-page-actions";
import { ReleasesTable } from "../../../components/admin-tables";
import { ReleaseRolloutsPanel } from "../../../components/release-rollouts-panel";
import { Pagination } from "../../../components/pagination";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ReleasesPage({ searchParams }) {
  const { t } = await getI18n();
  const params = await searchParams;
  const cursor = String(params?.cursor || "");
  const data = await loadAdmin(`/api/admin/releases${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { releases: [], nextCursor: "", total: null, latest: {} });
  const rows = data.releases || [];
  // Who is offered what, per platform — the release list below is the detail.
  const rollouts = cursor ? { platforms: [] } : await loadAdmin("/api/admin/rollouts", { platforms: [] });
  const rolloutError = String(params?.rolloutError || "");
  // "Offered now" is what everyone gets, rollouts considered — not merely the newest row.
  const offeredNow = Object.fromEntries((rollouts.platforms || []).filter((p) => p.full).map((p) => [p.platform, p.full.version]));
  const supportByPlatform = Object.fromEntries((rollouts.platforms || []).map((p) => [p.platform, p.support || {}]));
  return (
    <AdminShell title={t.admin.pages.releases[0]} subtitle={t.admin.pages.releases[1]}>
      <AdminPageActions actions={[{ href: "/admin/releases/new", label: t.admin.rollouts.newRelease, variant: "primary" }]} />
      {rolloutError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-800">{t.admin.rollouts.refused}: {rolloutError}</p> : null}
      <ReleaseRolloutsPanel platforms={rollouts.platforms || []} autoPause={rollouts.autoPause || null} />
      <ReleasesTable rows={rows} latest={Object.keys(offeredNow).length ? offeredNow : data.latest || {}} support={supportByPlatform} empty={<AdminEmpty title={t.admin.pages.releases[0]} description={t.admin.pages.releases[1]} />} />
      <Pagination
        basePath="/admin/releases"
        searchParams={params || {}}
        shown={rows.length}
        total={data.total ?? null}
        nextCursor={data.nextCursor || ""}
        cursor={cursor}
        copy={t.admin.paging}
      />
    </AdminShell>
  );
}
