import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SectionHead } from "../site/section-head";

// Wishes come from the server and may be missing: hide the block when empty,
// and let the grid take as many columns as there are wishes (max 3).
export function WishPoolPreview({ wishes, copy }) {
  if (!wishes.length) return null;
  const columns = Math.min(wishes.length, 3);
  return (
    <section className="site-section hm-wishes">
      <div className="shell">
        <div className="hm-wish-head">
          <SectionHead eyebrow={copy.eyebrow} title={copy.title} description={copy.description} />
          <Link href="/wishes" className="site-link hm-more">{copy.all}<ArrowUpRight className="site-flip" size={16} /></Link>
        </div>
        <div className="hm-wish-grid" data-count={columns} style={{ "--hm-cols": columns }}>
          {wishes.map((wish) => (
            <Link href="/wishes" className="site-card site-card--interactive hm-wish" key={wish.id}>
              <span className={`site-chip hm-wish-status${wish.status === "shipped" || wish.status === "building" ? " site-chip--brand" : ""}`}>{copy.statuses[wish.status] || wish.status}</span>
              <h3 className="site-h3">{wish.title}</h3>
              <p className="site-body">{wish.summary}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
