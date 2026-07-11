import Link from "next/link";
import { ArrowUpRight, Boxes, Sparkles } from "lucide-react";

export function FeaturedCatalog({ apps, skills, copy }) {
  if (!apps.length && !skills.length) return null;
  return (
    <section className="home-section home-catalog-section">
      <div className="shell">
        <div className="home-section-heading">
          <p className="home-eyebrow">{copy.eyebrow}</p>
          <h2>{copy.title}</h2>
        </div>
        {apps.length ? (
          <div className="home-catalog-block">
            <div className="home-subheading"><h3>{copy.appsTitle}</h3><Link href="/apps">{copy.allApps}<ArrowUpRight size={16} /></Link></div>
            <div className="home-app-grid">
              {apps.map((app) => <Link href={`/apps/${app.id}`} className="home-app-card" key={app.id}><span className="home-card-icon"><Boxes size={22} /></span><div><h4>{app.name}</h4><p>{app.summary}</p></div><ArrowUpRight className="home-card-arrow" size={18} /></Link>)}
            </div>
          </div>
        ) : null}
        {skills.length ? (
          <div className="home-catalog-block">
            <div className="home-subheading"><h3>{copy.skillsTitle}</h3><Link href="/skills">{copy.allSkills}<ArrowUpRight size={16} /></Link></div>
            <div className="home-skill-grid">
              {skills.map((skill) => <Link href={`/skills#${skill.id}`} className="home-skill-chip" key={skill.id}><Sparkles size={17} /><span><b>{skill.name}</b><small>{skill.categoryLabel || skill.category}</small></span></Link>)}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
