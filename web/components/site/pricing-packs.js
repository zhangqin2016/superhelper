import Link from "next/link";
import { ArrowRight } from "lucide-react";

function StatusPanel({ title, desc, contact }) {
  return (
    <div className="pr-status site-card" role="status">
      <div>
        <h3 className="site-h3">{title}</h3>
        <p className="pr-status-desc">{desc}</p>
      </div>
      <Link href="/contact" className="site-btn site-btn--secondary">
        {contact}
        <ArrowRight size={16} className="pr-arrow" aria-hidden="true" />
      </Link>
    </div>
  );
}

function ProductCard({ item, copy, purchasable }) {
  return (
    <article className={`pr-product site-card${item.featured ? " pr-product--featured" : ""}`}>
      <div className="pr-product-top">
        <h4 className="pr-product-name">{item.name}</h4>
        {item.featured ? <span className="site-chip site-chip--brand">{copy.recommended}</span> : null}
      </div>
      <p className="pr-product-price site-num">{item.price}</p>
      {item.unit ? <p className="pr-product-unit site-num">{item.unit}</p> : null}
      {item.validity ? <p className="pr-product-meta site-num">{item.validity}</p> : null}
      {item.description ? <p className="pr-product-desc">{item.description}</p> : null}
      {purchasable ? (
        <Link href="/account/billing" className={`site-btn site-btn--sm ${item.featured ? "site-btn--primary" : "site-btn--secondary"} pr-product-cta`}>
          {copy.buy}
        </Link>
      ) : null}
    </article>
  );
}

/** Real products from the server, grouped; or an honest panel saying why there are none. */
export function PricingPacks({ copy, state }) {
  const packs = copy.packs;
  return (
    <section className="pr-packs" aria-labelledby="pr-packs-title">
      <div className="pr-section-head">
        <p className="site-eyebrow">{packs.eyebrow}</p>
        <h2 id="pr-packs-title" className="site-h2">{packs.title}</h2>
        {state.status === "products" ? <p className="site-lead pr-section-lead">{packs.lead}</p> : null}
      </div>

      {state.status === "products" ? (
        <>
          {!state.purchasable ? <p className="pr-notice">{packs.paymentSoon} <Link href="/contact" className="site-link">{packs.contact}</Link></p> : null}
          {state.groups.map((group) => (
            <div key={group.key} className="pr-group">
              <h3 className="pr-group-title">{packs.groups[group.key] || packs.groups.other}</h3>
              <div className="pr-product-grid">
                {group.items.map((item) => <ProductCard key={item.id} item={item} copy={packs} purchasable={state.purchasable} />)}
              </div>
            </div>
          ))}
        </>
      ) : state.status === "region" ? (
        <StatusPanel title={packs.regionTitle} desc={packs.regionDesc} contact={packs.contact} />
      ) : state.status === "unavailable" ? (
        <StatusPanel title={packs.unavailableTitle} desc={packs.unavailableDesc} contact={packs.contact} />
      ) : (
        <StatusPanel title={packs.emptyTitle} desc={packs.emptyDesc} contact={packs.contact} />
      )}
    </section>
  );
}
