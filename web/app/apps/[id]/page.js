import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { notFound } from "next/navigation";
import { AppCover, appTypeLabel } from "../../../components/app-catalog";
import { PublicCatalogShell } from "../../../components/public-catalog-shell";
import { normalizeApps } from "../../../lib/public-catalog.mjs";
import { publicApiGet } from "../../../lib/public-api";
import { getI18n } from "../../../lib/i18n.mjs";
import { catalogCopyFor } from "../../../lib/site-copy-catalog.mjs";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { id } = await params;
  return {
    title: "App details",
    description: "Explore a Lily app and use it in your desktop workbench.",
    alternates: { canonical: `/apps/${encodeURIComponent(id)}` },
  };
}

export default async function AppDetailPage({ params }) {
  const { id } = await params;
  const { locale, t } = await getI18n();
  const copy = { ...t.catalog.apps, ...catalogCopyFor(locale).apps };
  const result = await publicApiGet("/api/apps/catalog");
  if (!result.ok) {
    return (
      <PublicCatalogShell locale={locale} eyebrow={copy.eyebrow} title={copy.errorTitle} description={copy.errorDescription}>
        <section className="pc-section"><div className="shell"><Link href="/apps" className="pc-back"><ArrowLeft size={16} aria-hidden="true" />{copy.back}</Link></div></section>
      </PublicCatalogShell>
    );
  }
  const apps = normalizeApps(result.data);
  const index = apps.findIndex((item) => item.id === id);
  if (index < 0) notFound();
  const app = apps[index];
  const facts = [
    [copy.typeLabel, appTypeLabel(copy, app.appType)],
    [copy.publisherLabel, app.publisher],
    [copy.version, app.latestVersion || "—"],
    [copy.plan, copy.plans?.[app.minPlan] || app.minPlan],
  ];
  return (
    <PublicCatalogShell locale={locale} eyebrow={copy.categories?.[app.category] || copy.eyebrow} title={app.name} description={app.summary}>
      <section className="pc-section"><div className="shell">
        <Link href="/apps" className="pc-back"><ArrowLeft size={16} aria-hidden="true" />{copy.back}</Link>
        <div className="pc-detail">
          <div className="pc-detail-main">
            <AppCover app={app} index={index} size="hero" />
            <h2 className="site-h3 pc-detail-heading">{copy.whatItDoes}</h2>
            <p className="site-body pc-detail-text">{app.description || app.summary}</p>
            <h2 className="site-h3 pc-detail-heading">{copy.howTitle}</h2>
            <ol className="pc-detail-steps">{copy.howSteps.map((step) => <li key={step}>{step}</li>)}</ol>
          </div>
          <aside className="pc-detail-panel site-card">
            <dl>
              {facts.map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd className="site-num">{value}</dd></div>
              ))}
            </dl>
            <Link href="/download" className="site-btn site-btn--primary pc-detail-cta"><Download size={17} aria-hidden="true" />{copy.useInLily}</Link>
          </aside>
        </div>
      </div></section>
    </PublicCatalogShell>
  );
}
