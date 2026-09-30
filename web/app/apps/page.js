import { AppCatalog } from "../../components/app-catalog";
import { PublicCatalogShell } from "../../components/public-catalog-shell";
import { normalizeApps } from "../../lib/public-catalog.mjs";
import { publicApiGet } from "../../lib/public-api";
import { getI18n } from "../../lib/i18n.mjs";
import { catalogCopyFor, formatCount } from "../../lib/site-copy-catalog.mjs";

export const metadata = { title: "Apps", description: "Browse ready-to-use Lily workspaces, tools, dashboards, and templates.", alternates: { canonical: "/apps" } };
export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const { locale, t } = await getI18n();
  const result = await publicApiGet("/api/apps/catalog");
  const apps = result.ok ? normalizeApps(result.data) : [];
  const copy = { ...t.catalog.apps, ...catalogCopyFor(locale).apps };
  return (
    <PublicCatalogShell locale={locale} eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
      <section className="pc-section"><div className="shell">
        {result.ok ? (
          apps.length ? (
            <>
              <p className="pc-count site-num">{formatCount(copy.count, apps.length)}</p>
              <AppCatalog apps={apps} copy={copy} />
            </>
          ) : <div className="pc-state site-card"><h2 className="site-h3">{copy.emptyTitle}</h2><p>{copy.emptyDescription}</p></div>
        ) : <div className="pc-state pc-state--error site-card"><h2 className="site-h3">{copy.errorTitle}</h2><p>{copy.errorDescription}</p></div>}
      </div></section>
    </PublicCatalogShell>
  );
}
