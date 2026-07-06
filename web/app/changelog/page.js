import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { safeApiGet } from "../../lib/api";
import { getI18n } from "../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ChangelogPage() {
  const { locale, t } = await getI18n();
  const data = await safeApiGet("/api/releases", { releases: [] });
  const releases = data.releases || [];
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="min-h-screen bg-white pt-28">
        <div className="shell py-16">
          <h1 className="text-5xl font-semibold">{t.pages.changelogTitle}</h1>
          <div className="mt-10 space-y-6">
            {releases.length ? releases.map((release) => (
              <div key={release.id} className="table-card p-6">
                <div className="font-mono text-sm text-brand">{release.version} · {release.platform}</div>
                <h2 className="mt-2 text-2xl font-semibold">{release.force ? "Required update" : "Platform update"}</h2>
                <p className="mt-2 whitespace-pre-line text-slate-500">{release.notes || "No release notes provided."}</p>
                <p className="mt-4 text-xs uppercase tracking-[0.18em] text-slate-400">
                  {release.createdAt ? new Date(release.createdAt).toLocaleDateString("en-US") : ""}
                </p>
              </div>
            )) : (
              <div className="table-card p-6">
                <div className="font-mono text-sm text-brand">No releases</div>
                <h2 className="mt-2 text-2xl font-semibold">Release notes will appear here</h2>
                <p className="mt-2 text-slate-500">Create enabled releases in the admin console to populate this page.</p>
              </div>
            )}
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
