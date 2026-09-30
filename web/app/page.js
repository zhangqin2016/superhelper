import "../components/site/site-shared.css";
import "../components/site/product-mock.css";
import "./home.css";
import { FeaturedCatalog } from "../components/home/featured-catalog";
import { HomeCapabilities } from "../components/home/home-capabilities";
import { HomeEnterprise } from "../components/home/home-enterprise";
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
import { enterpriseContentFor } from "../lib/site-copy-enterprise.mjs";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { locale } = await getI18n();
  const copy = homeContentFor(locale);
  const enterprise = enterpriseContentFor(locale);
  const optionalFetch = { timeoutMs: 1200 };
  const [appsResult, skillsResult, wishesResult] = await Promise.all([
    publicApiGet("/api/apps/catalog", optionalFetch),
    publicApiGet(`/api/skills/registry?locale=${locale}`, optionalFetch),
    publicApiGet(`/api/wishes?sort=popular&locale=${locale}`, optionalFetch),
  ]);
  const { apps, skills, wishes } = buildHomeOptionalSections({ appsResult, skillsResult, wishesResult, locale });

  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="hm">
        <HomeHero copy={copy.hero} mock={copy.mock} />
        <HomeWorkflows copy={copy.how} />
        <HomeCapabilities copy={copy.capabilities} mini={copy.mini} />
        <HomeEnterprise copy={copy.enterprise} orgMock={enterprise.mocks.org} mockLabel={enterprise.hero.mockLabel} />
        <FeaturedCatalog apps={apps} skills={skills} copy={copy.catalog} />
        <HomeTrust copy={copy.trust} />
        <WishPoolPreview wishes={wishes} copy={copy.wishes} />
        <HomeFinalCta copy={copy.finalCta} />
      </main>
      <SiteFooter />
    </>
  );
}
