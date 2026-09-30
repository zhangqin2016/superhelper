import { Check, Minus } from "lucide-react";

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? `{${key}}`));
}

function Cell({ value, copy }) {
  if (value === true) return <span className="pr-mark pr-mark--yes"><Check size={16} strokeWidth={2.25} aria-hidden="true" /><span className="pr-sr">{copy.yes}</span></span>;
  if (value === false) return <span className="pr-mark pr-mark--no"><Minus size={16} aria-hidden="true" /><span className="pr-sr">{copy.no}</span></span>;
  if (Array.isArray(value)) return <span className="pr-cell-lines">{value.filter(Boolean).map((line) => <span key={line}>{line}</span>)}</span>;
  return <span>{value}</span>;
}

/**
 * Pro / Max / Enterprise Standard / Enterprise Premium, one row each, as a
 * real table so screen readers read it row by row. Prices are the same ones
 * the cards show (the server's when a plan product exists, else the quote).
 */
export function PricingCompare({ copy, plans, enterprise }) {
  const compare = copy.compare;
  const seats = Object.fromEntries(enterprise.map((tier) => [tier.tier, tier]));
  const rows = [
    ...plans.tiers.map((tier) => ({
      key: tier.tier,
      name: copy.plans.tiers[tier.tier].name,
      price: [`${tier.month.price}${copy.plans.perMonth}`, `${tier.year.price}${copy.plans.perYear}`],
      weekly: tier.month.weeklyUnits > 0 ? tier.month.weekly : tier.year.weeklyUnits > 0 ? tier.year.weekly : "",
    })),
    ...enterprise.map((tier) => ({
      key: tier.tier,
      name: copy.enterprisePlans.tiers[tier.tier].name,
      price: [`${tier.month}${copy.enterprisePlans.perSeatMonth}`, `${tier.year}${copy.enterprisePlans.perSeatYear}`],
      weekly: "",
    })),
  ];

  return (
    <section className="pr-compare" aria-labelledby="pr-compare-title">
      <div className="pr-section-head">
        <p className="site-eyebrow">{compare.eyebrow}</p>
        <h2 id="pr-compare-title" className="site-h2">{compare.title}</h2>
      </div>
      <div className="pr-table-wrap site-card">
        <table className="pr-table pr-table--plans">
          <thead>
            <tr>
              {compare.columns.map((label, index) => (
                <th key={index} scope="col">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const [model, agents, allowance, hasConsole, start] = compare.rows[row.key];
              const minSeats = seats[row.key]?.minSeats;
              return (
                <tr key={row.key}>
                  <th scope="row">{row.name}</th>
                  <td className="site-num"><Cell value={row.price} copy={compare} /></td>
                  <td><Cell value={model} copy={compare} /></td>
                  <td><Cell value={agents} copy={compare} /></td>
                  <td className="site-num"><Cell value={row.weekly ? [row.weekly, allowance] : allowance} copy={compare} /></td>
                  <td><Cell value={hasConsole} copy={compare} /></td>
                  <td><Cell value={fill(start, { n: minSeats ?? "" })} copy={compare} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
