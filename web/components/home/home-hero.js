import Link from "next/link";
import { ArrowDown, Download } from "lucide-react";
import { ProductMock } from "../site/product-mock";

export function HomeHero({ copy, mock }) {
  return (
    <section className="hm-hero">
      <div className="shell">
        <div className="hm-hero-copy">
          <p className="site-eyebrow">{copy.eyebrow}</p>
          <h1 className="site-display">{copy.title}</h1>
          <p className="site-lead hm-hero-lead">{copy.description}</p>
          <div className="hm-actions">
            <Link href="/download" className="site-btn site-btn--primary site-btn--lg"><Download size={18} />{copy.primaryCta}</Link>
            <Link href="#product-demo" className="site-btn site-btn--secondary site-btn--lg">{copy.secondaryCta}<ArrowDown size={17} /></Link>
          </div>
          <p className="hm-note">{copy.note}</p>
        </div>
        <div className="hm-hero-visual">
          <ProductMock copy={mock} label={copy.mockLabel} className="pm-frame--lifted" />
        </div>
      </div>
    </section>
  );
}
