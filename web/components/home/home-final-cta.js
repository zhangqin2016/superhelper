import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";

export function HomeFinalCta({ copy }) {
  return (
    <section className="site-section hm-final">
      <div className="shell hm-final-inner">
        <h2 className="site-h1">{copy.title}</h2>
        <p className="site-lead">{copy.description}</p>
        <div className="hm-actions">
          <Link href="/download" className="site-btn site-btn--primary site-btn--lg"><Download size={18} />{copy.primary}</Link>
          <Link href="/pricing" className="site-btn site-btn--ghost site-btn--lg">{copy.secondary}<ArrowRight className="site-flip" size={17} /></Link>
        </div>
      </div>
    </section>
  );
}
