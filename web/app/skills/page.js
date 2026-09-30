import "./skills.css";
import { PublicCatalogShell } from "../../components/public-catalog-shell";
import { SkillCatalog } from "../../components/skill-catalog";
import { normalizeSkills } from "../../lib/public-catalog.mjs";
import { publicApiGet } from "../../lib/public-api";
import { getI18n } from "../../lib/i18n.mjs";
import { catalogCopyFor } from "../../lib/site-copy-catalog.mjs";

export const metadata = { title: "Skills", description: "Browse focused Lily skills for documents, research, data, design, and quality work.", alternates: { canonical: "/skills" } };
export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const { locale, t } = await getI18n();
  const result = await publicApiGet("/api/skills/registry");
  const skills = result.ok ? normalizeSkills(result.data, locale) : [];
  const copy = { ...t.catalog.skills, ...catalogCopyFor(locale).skills };
  return (
    <PublicCatalogShell locale={locale} eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
      <section className="pc-section"><div className="shell">
        {result.ok ? (
          skills.length ? <SkillCatalog skills={skills} copy={copy} /> : <div className="pc-state site-card"><h2 className="site-h3">{copy.emptyTitle}</h2><p>{copy.emptyDescription}</p></div>
        ) : <div className="pc-state pc-state--error site-card"><h2 className="site-h3">{copy.errorTitle}</h2><p>{copy.errorDescription}</p></div>}
      </div></section>
    </PublicCatalogShell>
  );
}
