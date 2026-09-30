import Link from "next/link";
import { ArrowUpRight, Boxes, Sparkles } from "lucide-react";
import { SectionHead } from "../site/section-head";

// Catalog data comes from the server and may be empty or unavailable: each
// block renders only with items, the app grid sizes itself to the count, and
// the whole section disappears when both are empty.
export function FeaturedCatalog({ apps, skills, copy }) {
  if (!apps.length && !skills.length) return null;
  const appColumns = Math.min(apps.length, 3);
  return (
    <section className="site-section hm-catalog">
      <div className="shell">
        <SectionHead eyebrow={copy.eyebrow} title={copy.title} />
        {apps.length ? (
          <div className="hm-catalog-block">
            <div className="hm-subhead">
              <h3 className="site-h3">{copy.appsTitle}</h3>
              <Link href="/apps" className="site-link hm-more">{copy.allApps}<ArrowUpRight className="site-flip" size={16} /></Link>
            </div>
            <div className="hm-app-grid" data-count={appColumns} style={{ "--hm-cols": appColumns }}>
              {apps.map((app) => (
                <Link href={`/apps/${app.id}`} className="site-card site-card--interactive hm-app" key={app.id}>
                  <span className="hm-app-icon"><Boxes size={19} strokeWidth={1.8} /></span>
                  <span className="hm-app-text"><b>{app.name}</b><span>{app.summary}</span></span>
                  <ArrowUpRight className="hm-app-arrow site-flip" size={17} />
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {skills.length ? (
          <div className="hm-catalog-block">
            <div className="hm-subhead">
              <h3 className="site-h3">{copy.skillsTitle}</h3>
              <Link href="/skills" className="site-link hm-more">{copy.allSkills}<ArrowUpRight className="site-flip" size={16} /></Link>
            </div>
            <div className="hm-skill-list">
              {skills.map((skill) => (
                <Link href={`/skills#${skill.id}`} className="hm-skill" key={skill.id}>
                  <Sparkles size={15} strokeWidth={1.9} />
                  <b>{skill.name}</b>
                  {skill.categoryLabel || skill.category ? <small>{skill.categoryLabel || skill.category}</small> : null}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
