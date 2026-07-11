import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";

export function HomeFinalCta({ copy }) {
  return (
    <section className="home-final">
      <div className="shell home-final-inner">
        <div><h2>{copy.title}</h2><p>{copy.description}</p></div>
        <div className="home-final-actions">
          <Link href="/download" className="home-button home-button--light"><Download size={18} />{copy.primary}</Link>
          <Link href="/pricing" className="home-button home-button--ghost">{copy.secondary}<ArrowRight size={18} /></Link>
        </div>
      </div>
    </section>
  );
}
