import Link from "next/link";
import { ArrowUpRight, Lightbulb } from "lucide-react";

export function WishPoolPreview({ wishes, copy }) {
  if (!wishes.length) return null;
  return (
    <section className="home-section home-wishes">
      <div className="shell">
        <div className="home-section-heading home-wish-heading">
          <div><p className="home-eyebrow">{copy.eyebrow}</p><h2>{copy.title}</h2><p>{copy.description}</p></div>
          <Link href="/wishes" className="home-text-link">{copy.all}<ArrowUpRight size={17} /></Link>
        </div>
        <div className="home-wish-grid">
          {wishes.map((wish) => <Link href="/wishes" className="home-wish-card" key={wish.id}><Lightbulb size={19} /><span className={`home-wish-status home-wish-status--${wish.status}`}>{wish.status}</span><h3>{wish.title}</h3><p>{wish.summary}</p></Link>)}
        </div>
      </div>
    </section>
  );
}
