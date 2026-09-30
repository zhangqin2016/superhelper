import { Check, Minus } from "lucide-react";

function Cell({ value, copy }) {
  if (value === true) return <span className="pr-mark pr-mark--yes"><Check size={16} strokeWidth={2.25} aria-hidden="true" /><span className="pr-sr">{copy.yes}</span></span>;
  if (value === false) return <span className="pr-mark pr-mark--no"><Minus size={16} aria-hidden="true" /><span className="pr-sr">{copy.no}</span></span>;
  return <span>{value}</span>;
}

/** Personal vs Enterprise, as a real table so screen readers read it row by row. */
export function PricingCompare({ copy }) {
  const compare = copy.compare;
  return (
    <section className="pr-compare" aria-labelledby="pr-compare-title">
      <div className="pr-section-head">
        <p className="site-eyebrow">{compare.eyebrow}</p>
        <h2 id="pr-compare-title" className="site-h2">{compare.title}</h2>
      </div>
      <div className="pr-table-wrap site-card">
        <table className="pr-table">
          <thead>
            <tr>
              {compare.columns.map((label, index) => (
                <th key={index} scope="col">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {compare.rows.map(([label, personal, enterprise]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td><Cell value={personal} copy={compare} /></td>
                <td><Cell value={enterprise} copy={compare} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
