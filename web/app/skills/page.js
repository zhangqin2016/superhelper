import { PublicCatalogShell } from "../../components/public-catalog-shell";
import { SkillCatalog } from "../../components/skill-catalog";
import { normalizeSkills } from "../../lib/public-catalog.mjs";
import { publicApiGet } from "../../lib/public-api";
import { getI18n } from "../../lib/i18n.mjs";

export const metadata = { title: "Skills", description: "Browse focused Lily skills for documents, research, data, design, and quality work.", alternates: { canonical: "/skills" } };
export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const { locale, t } = await getI18n();
  const result = await publicApiGet("/api/skills/registry");
  const skills = result.ok ? normalizeSkills(result.data, locale) : [];
  const copy = t.catalog.skills;
  return (
    <PublicCatalogShell locale={locale} eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
      <section className="catalog-section"><div className="shell">
        {result.ok ? (
          skills.length ? <SkillCatalog skills={skills} copy={copy} /> : <div className="catalog-state"><h2>{copy.emptyTitle}</h2><p>{copy.emptyDescription}</p></div>
        ) : <div className="catalog-state catalog-state--error"><h2>{copy.errorTitle}</h2><p>{copy.errorDescription}</p></div>}
      </div></section>
    </PublicCatalogShell>
  );
}
