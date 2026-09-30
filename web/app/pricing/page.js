import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { PricingPlans } from "../../components/site/pricing-plans";
import { PricingPacks } from "../../components/site/pricing-packs";
import { PricingCompare } from "../../components/site/pricing-compare";
import { PricingFaq } from "../../components/site/pricing-faq";
import { getI18n } from "../../lib/i18n.mjs";
import { publicApiGet } from "../../lib/public-api";
import { copyFor, pricingState } from "../../lib/site-copy-pricing.mjs";
import "./pricing.css";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { locale } = await getI18n();
  const { meta } = copyFor(locale);
  return { title: meta.title, description: meta.description, alternates: { canonical: "/pricing" } };
}

export default async function PricingPage() {
  const { locale } = await getI18n();
  const copy = copyFor(locale);
  // Real prices only: a short timeout, and a failure or a regional 403 shows
  // an honest panel instead of numbers the server never gave.
  const state = pricingState(await publicApiGet("/api/billing/products", { timeoutMs: 2500 }), locale);

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="pr-page">
        <div className="shell">
          <header className="site-page-head pr-head">
            <p className="site-eyebrow">{copy.head.eyebrow}</p>
            <h1 className="site-h1">{copy.head.title}</h1>
            <p className="site-lead pr-head-lead">{copy.head.lead}</p>
          </header>
          <PricingPlans copy={copy} />
          <PricingPacks copy={copy} state={state} />
          <PricingCompare copy={copy} />
          <PricingFaq copy={copy} />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
