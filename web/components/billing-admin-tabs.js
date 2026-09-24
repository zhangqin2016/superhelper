import Link from "next/link";

// The billing section's own tabs: money in (orders), what is sold (products),
// what usage costs (pricing), and whether our books match the provider's.
const TABS = [
  ["orders", "订单", "/admin/billing/orders"],
  ["products", "商品档位", "/admin/billing/products"],
  ["pricing", "能力计价", "/admin/billing/pricing"],
  ["reconciliation", "对账", "/admin/billing/reconciliation"],
];

export function BillingAdminTabs({ active }) {
  return (
    <nav className="mb-5 flex flex-wrap gap-1 border-b border-slate-200 text-sm" aria-label="计费">
      {TABS.map(([key, label, href]) => (
        <Link
          key={key}
          href={href}
          aria-current={key === active ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 ${key === active ? "border-slate-900 font-semibold text-slate-950" : "border-transparent text-slate-500 hover:text-slate-800"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
