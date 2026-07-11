import Link from "next/link";
import { ArrowUpRight, CheckCircle2, Sparkles } from "lucide-react";

export function SkillCatalog({ skills, copy }) {
  const groups = new Map();
  for (const skill of skills) {
    const key = skill.categoryLabel || skill.category;
    const list = groups.get(key) || [];
    list.push(skill);
    groups.set(key, list);
  }
  return (
    <div className="skill-groups">
      {[...groups.entries()].map(([category, items]) => (
        <section key={category} className="skill-group">
          <div className="skill-group-heading"><span>{category}</span><small>{items.length}</small></div>
          <div className="catalog-grid catalog-grid--skills">
            {items.map((skill) => (
              <article className="catalog-card catalog-card--skill" key={skill.id}>
                <div className="skill-mark"><Sparkles size={20} /></div>
                <div className="catalog-card-meta"><span>{skill.publisher}</span><span>{copy.risks[skill.riskLevel] || skill.riskLevel}</span></div>
                <h2>{skill.name}</h2>
                <p>{skill.description || copy.noDescription}</p>
                <div className="catalog-card-footer"><span><CheckCircle2 size={14} />{copy.availableInLily}</span><Link href="/download">{copy.getLily}<ArrowUpRight size={15} /></Link></div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
