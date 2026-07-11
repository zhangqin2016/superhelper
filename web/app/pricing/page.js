import Link from "next/link";
import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { getI18n } from "../../lib/i18n.mjs";

export const metadata = { title: "Pricing", description: "Choose a Lily Workbench plan for personal work or your team.", alternates: { canonical: "/pricing" } };

export default async function PricingPage() {
  const { locale, t } = await getI18n();
  return (
    <>
      <SiteNav initialLocale={locale} />
      <main className="min-h-screen bg-white pt-28">
        <div className="shell py-16">
          <h1 className="text-5xl font-semibold">{t.pages.pricingTitle}</h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-500">{t.pages.pricingDesc}</p>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {t.pages.pricingPlans.map(([name, badge, seats, items]) => (
              <div key={name} className={`rounded-2xl border p-6 ${name === "Team" ? "border-brand bg-slate-950 text-white" : "border-slate-200 bg-slate-50"}`}>
                <div className="mb-5 inline-flex rounded-full bg-brand/12 px-3 py-1 text-sm text-brand">{badge}</div>
                <h2 className="text-2xl font-semibold">{name}</h2>
                <p className={`mt-2 ${name === "Team" ? "text-white/56" : "text-slate-500"}`}>{seats}</p>
                <Link href="/contact" className={`mt-6 block w-full rounded-lg px-4 py-3 text-center font-semibold ${name === "Team" ? "bg-white text-slate-950" : "bg-slate-950 text-white"}`}>
                  {t.nav.contact}
                </Link>
                <ul className="mt-6 space-y-3 text-sm">
                  {items.map((item) => <li key={item}>• {item}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
