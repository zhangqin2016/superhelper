import { FeaturedCatalog } from "../components/home/featured-catalog";
import { HomeFinalCta } from "../components/home/home-final-cta";
import { HomeHero } from "../components/home/home-hero";
import { HomeTrust } from "../components/home/home-trust";
import { HomeWorkflows } from "../components/home/home-workflows";
import { WishPoolPreview } from "../components/home/wish-pool-preview";
import { SiteFooter } from "../components/site-footer";
import { SiteNav } from "../components/site-nav";
import { buildHomeOptionalSections, homeContentFor } from "../lib/homepage-content.mjs";
import { getI18n } from "../lib/i18n.mjs";
import { publicApiGet } from "../lib/public-api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { locale, t } = await getI18n();
  const copy = homeContentFor(t);
  const [appsResult, skillsResult, wishesResult] = await Promise.all([
    publicApiGet("/api/apps/catalog"),
    publicApiGet(`/api/skills/registry?locale=${locale}`),
    publicApiGet(`/api/wishes?sort=popular&locale=${locale}`),
  ]);
  const { apps, skills, wishes } = buildHomeOptionalSections({ appsResult, skillsResult, wishesResult, locale });

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="premium-home">
        <HomeHero copy={copy.hero} />
        <HomeWorkflows problem={copy.problem} copy={copy.workflows} />
        <FeaturedCatalog apps={apps} skills={skills} copy={copy.catalog} />
        <HomeTrust copy={copy.trust} />
        <WishPoolPreview wishes={wishes} copy={copy.wishes} />
        <HomeFinalCta copy={copy.finalCta} />
      </main>
      <SiteFooter />
    </>
  );
}
