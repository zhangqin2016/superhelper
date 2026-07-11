import Link from "next/link";
import { ArrowLeft, CheckCircle2, Download, ShieldCheck } from "lucide-react";
import { notFound } from "next/navigation";
import { PublicCatalogShell } from "../../../components/public-catalog-shell";
import { normalizeApps } from "../../../lib/public-catalog.mjs";
import { publicApiGet } from "../../../lib/public-api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function AppDetailPage({ params }) {
  const { id } = await params;
  const { locale, t } = await getI18n();
  const result = await publicApiGet("/api/apps/catalog");
  if (!result.ok) {
    return <PublicCatalogShell locale={locale} eyebrow={t.catalog.apps.eyebrow} title={t.catalog.apps.errorTitle} description={t.catalog.apps.errorDescription} />;
  }
  const app = normalizeApps(result.data).find((item) => item.id === id);
  if (!app) notFound();
  const copy = t.catalog.apps;
  return (
    <PublicCatalogShell locale={locale} eyebrow={copy.eyebrow} title={app.name} description={app.summary}>
      <section className="catalog-section"><div className="shell catalog-detail">
        <div>
          <Link href="/apps" className="catalog-back"><ArrowLeft size={16} />{copy.back}</Link>
          <div className="catalog-detail-copy"><h2>{copy.whatItDoes}</h2><p>{app.description || app.summary}</p></div>
        </div>
        <aside className="catalog-detail-panel">
          <div><ShieldCheck size={19} /><span>{app.publisher}</span></div>
          <div><CheckCircle2 size={19} /><span>{copy.version} {app.latestVersion || "-"}</span></div>
          <div><CheckCircle2 size={19} /><span>{copy.plan}: {app.minPlan}</span></div>
          <Link href="/download" className="catalog-primary-action"><Download size={17} />{copy.useInLily}</Link>
        </aside>
      </div></section>
    </PublicCatalogShell>
  );
}
