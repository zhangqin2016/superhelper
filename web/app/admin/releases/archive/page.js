import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { DangerForm } from "../../../../components/danger-form";
import { Button } from "../../../../components/ui/button";
import { archiveReleasesAction, restoreReleaseAction, setArchiveSettingsAction } from "../../actions";
import { loadAdmin } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

// Old installers leave object storage only when an operator has seen exactly
// which files, for which versions, and still-running device counts.
export default async function ReleaseArchivePage({ searchParams }) {
  const { t } = await getI18n();
  const c = t.admin.rollouts;
  const params = (await searchParams) || {};
  const data = await loadAdmin("/api/admin/release-archive/preview", { settings: { olderThanDays: 30 }, configured: false, candidates: [], archived: [] });
  const candidates = data.candidates || [];
  const objects = candidates.reduce((sum, item) => sum + (item.objects || []).length, 0);
  const [releases, moved, failed, skipped] = String(params.done || "").split(":");
  return (
    <AdminShell title={c.archiveTitle} subtitle={c.archiveHelp}>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <Link href="/admin/releases" className="text-brand hover:underline">← {t.admin.nav.releases}</Link>
        <form action={setArchiveSettingsAction} className="flex items-center gap-2">
          <label className="text-slate-600" htmlFor="olderThanDays">{c.archiveRetention}</label>
          <input id="olderThanDays" name="olderThanDays" type="number" min="7" defaultValue={data.settings?.olderThanDays ?? 30} className="w-20 rounded-md border border-slate-300 px-2 py-1" />
          <Button variant="outline" size="sm">{c.saveAutoPause}</Button>
        </form>
      </div>
      {params.rolloutError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-800">{c.refused}: {params.rolloutError}</p> : null}
      {params.done ? <p role="status" className="mb-3 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{c.archiveDone.replace("{releases}", releases || "0").replace("{moved}", moved || "0").replace("{failed}", failed || "0").replace("{skipped}", skipped || "0")}</p> : null}
      {!data.configured ? <p className="mb-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">{c.archiveUnconfigured}</p> : null}
      {data.storageError ? <p role="alert" className="mb-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">{c.archiveStorageError}: {data.storageError}</p> : null}
      <div className="table-card mb-4 p-4">
        {candidates.length ? (
          <DangerForm action={archiveReleasesAction} confirm={c.archiveConfirm.replace("{n}", String(candidates.length)).replace("{objects}", String(objects))}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2" /><th className="px-3 py-2">{t.admin.cols.version}</th><th className="px-3 py-2">{t.admin.cols.platform}</th><th className="px-3 py-2">{t.admin.cols.created}</th><th className="px-3 py-2">{t.admin.cols.file}</th></tr></thead>
                <tbody>{candidates.map((item) => (
                  <tr key={item.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2"><input type="checkbox" name="releaseId" value={item.id} defaultChecked aria-label={`${item.platform} ${item.version}`} /></td>
                    <td className="px-3 py-2 font-mono">{item.version}</td>
                    <td className="px-3 py-2 text-xs">{t.admin.platforms?.[item.platform] || item.platform}</td>
                    <td className="px-3 py-2 text-slate-500">{new Date(item.created_at).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-xs">
                      <details><summary className="cursor-pointer">{c.archiveObjects.replace("{n}", String((item.objects || []).length))}</summary>
                        <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-slate-500">{(item.objects || []).map((key) => <li key={key} className="break-all">{key}</li>)}</ul>
                      </details>
                      {item.activeDevices ? <p className="mt-1 text-amber-700">{c.archiveStillUsed.replace("{n}", String(item.activeDevices))}</p> : null}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="mt-3"><Button variant="danger" size="sm" disabled={!data.configured || Boolean(data.storageError)}>{c.archiveRun}</Button></div>
          </DangerForm>
        ) : <AdminEmpty title={c.archiveNone} description={c.archiveHelp} />}
      </div>
      {(data.archived || []).length ? (
        <div className="table-card p-4">
          <h2 className="mb-2 text-sm font-semibold">{c.archived}</h2>
          <ul className="space-y-1 text-sm">{data.archived.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3">
              <span className="font-mono">{item.version}</span><span className="text-xs text-slate-500">{t.admin.platforms?.[item.platform] || item.platform}</span>
              <span className="text-xs text-slate-500">{new Date(item.archived_at).toLocaleDateString()} · {c.archiveObjects.replace("{n}", String((item.archived_objects || []).length))}</span>
              <form action={restoreReleaseAction}><input type="hidden" name="id" value={item.id} /><Button variant="outline" size="sm">{c.restore}</Button></form>
            </li>
          ))}</ul>
        </div>
      ) : null}
    </AdminShell>
  );
}
