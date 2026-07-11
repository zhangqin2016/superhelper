import Link from "next/link";
import { ArrowUpRight, CheckCircle2, Heart, Lightbulb } from "lucide-react";

export function WishBoard({ wishes, copy }) {
  return (
    <div className="wish-grid">
      {wishes.map((wish) => (
        <article className="wish-card" key={wish.id}>
          <div className="wish-card-top">
            <span className="wish-category"><Lightbulb size={14} />{copy.categories[wish.category] || wish.category}</span>
            <span className={`wish-status wish-status--${wish.status}`}>{copy.statuses[wish.status] || wish.status}</span>
          </div>
          <h2>{wish.title}</h2>
          <p>{wish.summary}</p>
          {wish.update ? <div className="wish-update"><CheckCircle2 size={15} />{wish.update}</div> : null}
          {wish.status === "shipped" && (wish.linkedAppIds.length || wish.linkedSkillIds.length) ? (
            <div className="wish-links">
              {wish.linkedAppIds.map((id) => <Link key={id} href={`/apps/${id}`}>{copy.viewOutcome}<ArrowUpRight size={14} /></Link>)}
              {wish.linkedSkillIds.map((id) => <Link key={id} href={`/skills#${id}`}>{copy.viewSkill}<ArrowUpRight size={14} /></Link>)}
            </div>
          ) : <button className="wish-support-placeholder" type="button"><Heart size={15} />{copy.alsoNeed}</button>}
        </article>
      ))}
    </div>
  );
}
