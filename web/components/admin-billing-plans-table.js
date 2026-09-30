import { formatMoney } from "../lib/billing-format.mjs";
import { creditUnit, creditsLabel } from "../lib/site-copy-pricing.mjs";

/**
 * Subscription plans at a glance: tier and period live in the product's
 * metadata, which the generic product table does not show, and they are what
 * the pricing page groups by — a plan without a tier is not shown there.
 */
export function AdminBillingPlansTable({ products = [], t, locale = "zh" }) {
  const raw = t?.admin?.billingProduct || {};
  const unitLabel = (text) => String(text || "").replace(/\{unit\}/g, creditUnit(locale));
  const cols = raw.cols || {};
  const plans = (Array.isArray(products) ? products : []).filter((product) => product?.resource_type === "plan");
  return (
    <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{raw.plansTitle}</h2>
        <span className="text-sm text-slate-500 tabular-nums">{plans.length}</span>
      </div>
      {plans.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-start text-slate-500">
              <tr>
                {["id", "name", "tier", "period", "days", "weekly", "price", "status"].map((key) => (
                  <th key={key} className="border-b border-slate-200 py-2 pe-4 text-start">{unitLabel(cols[key])}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plans.map((product) => {
                const meta = product.metadata && typeof product.metadata === "object" ? product.metadata : {};
                const units = Number(product.unit_amount || 0);
                return (
                  <tr key={product.id}>
                    <td className="border-b border-slate-100 py-3 pe-4 font-mono text-xs">{product.id}</td>
                    <td className="border-b border-slate-100 py-3 pe-4 font-medium">{product.name}</td>
                    <td className="border-b border-slate-100 py-3 pe-4">{raw.tiers?.[meta.plan] || <span className="text-red-700">—</span>}</td>
                    <td className="border-b border-slate-100 py-3 pe-4">{raw.periods?.[meta.period] || "—"}</td>
                    <td className="border-b border-slate-100 py-3 pe-4 tabular-nums">{Math.round(Number(product.duration_seconds || 0) / 86400) || "—"}</td>
                    <td className="border-b border-slate-100 py-3 pe-4 tabular-nums">{units > 0 ? creditsLabel(units, locale) : raw.none}</td>
                    <td className="border-b border-slate-100 py-3 pe-4 tabular-nums">{formatMoney(product.price_cents, product.currency)}</td>
                    <td className="border-b border-slate-100 py-3 pe-4">{raw.statuses?.[product.status] || product.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">{raw.plansEmpty}</p>
      )}
    </section>
  );
}
