import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";

export function HomeHero({ copy }) {
  return (
    <section className="home-hero">
      <div className="shell home-hero-inner">
        <div className="home-hero-copy">
          <p className="home-eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="home-hero-description">{copy.description}</p>
          <div className="home-hero-actions">
            <Link href="/download" className="home-button home-button--primary"><Download size={18} />{copy.primaryCta}</Link>
            <Link href="#product-demo" className="home-button home-button--secondary">{copy.secondaryCta}<ArrowRight size={18} /></Link>
          </div>
          <p className="home-hero-note">{copy.note}</p>
        </div>
        <div id="product-demo" className="home-product-visual">
          <picture>
            <source srcSet="/product/lily-workbench-home.webp" type="image/webp" />
            <img src="/product/lily-workbench-home-fallback.svg" alt="Lily Workbench" width="1600" height="1040" fetchPriority="high" />
          </picture>
        </div>
      </div>
    </section>
  );
}
