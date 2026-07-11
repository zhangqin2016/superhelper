import { AppCatalog } from "../../components/app-catalog";
import { PublicCatalogShell } from "../../components/public-catalog-shell";
import { normalizeApps } from "../../lib/public-catalog.mjs";
import { publicApiGet } from "../../lib/public-api";
import { getI18n } from "../../lib/i18n.mjs";

export const metadata = { title: "Lily Apps · Lily Workbench", description: "Ready-to-use Lily workspaces, tools, dashboards, and templates." };
export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const { locale, t } = await getI18n();
  const result = await publicApiGet("/api/apps/catalog");
  const apps = result.ok ? normalizeApps(result.data) : [];
  const copy = t.catalog.apps;
  return (
    <PublicCatalogShell locale={locale} eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
      <section className="catalog-section"><div className="shell">
        {result.ok ? (
          apps.length ? <AppCatalog apps={apps} copy={copy} /> : <div className="catalog-state"><h2>{copy.emptyTitle}</h2><p>{copy.emptyDescription}</p></div>
        ) : <div className="catalog-state catalog-state--error"><h2>{copy.errorTitle}</h2><p>{copy.errorDescription}</p></div>}
      </div></section>
    </PublicCatalogShell>
  );
}
