import { Quote, ScanEye, ShieldCheck, Undo2 } from "lucide-react";
import { SectionHead } from "../site/section-head";

const icons = [Quote, ScanEye, ShieldCheck, Undo2];

export function HomeTrust({ copy }) {
  return (
    <section className="site-section site-section--sunken hm-trust">
      <div className="shell">
        <SectionHead eyebrow={copy.eyebrow} title={copy.title} />
        <div className="hm-trust-grid">
          {copy.items.map(([title, description], index) => {
            const Icon = icons[index % icons.length];
            return (
              <article key={title} className="hm-trust-item">
                <span className="hm-icon"><Icon size={18} strokeWidth={1.8} /></span>
                <h3 className="site-h3">{title}</h3>
                <p className="site-body">{description}</p>
              </article>
            );
          })}
        </div>
        <p className="hm-trust-note">{copy.note}</p>
      </div>
    </section>
  );
}
