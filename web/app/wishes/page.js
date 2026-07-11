import Link from "next/link";
import { Plus } from "lucide-react";
import { PublicCatalogShell } from "../../components/public-catalog-shell";
import { WishBoard } from "../../components/wish-board";
import { WishSubmitForm } from "../../components/wish-submit-form";
import { classifyWishResult, normalizePublicWishes, wishQuery } from "../../lib/public-wishes.mjs";
import { userApiGetResult } from "../../lib/user-api";
import { getI18n } from "../../lib/i18n.mjs";

export const metadata = { title: "Wish pool", description: "Browse, support, or submit a real work need you want Lily to build.", alternates: { canonical: "/wishes" } };
export const dynamic = "force-dynamic";

export default async function WishesPage({ searchParams }) {
  const { locale, t } = await getI18n();
  const params = await searchParams;
  const query = wishQuery({ status: params?.status, category: params?.category, sort: params?.sort, locale });
  const result = await userApiGetResult(`/api/wishes${query}`);
  const state = classifyWishResult(result);
  const wishes = result.ok ? normalizePublicWishes(result.data) : [];
  const copy = t.wishPool;
  return (
    <PublicCatalogShell locale={locale} eyebrow={copy.eyebrow} title={copy.title} description={copy.description}>
      <section className="catalog-section"><div className="shell">
        <div className="wish-toolbar">
          <nav aria-label={copy.filterLabel}>
            <Link className={!params?.status ? "active" : ""} href={`/wishes?sort=${params?.sort === "recent" ? "recent" : "popular"}`}>{copy.tabs.all}</Link>
            {Object.entries(copy.tabs).filter(([key]) => key !== "all").map(([status, label]) => <Link className={params?.status === status ? "active" : ""} key={status} href={`/wishes?status=${status}&sort=${params?.sort === "recent" ? "recent" : "popular"}`}>{label}</Link>)}
          </nav>
          <Link className="wish-create-link" href="#make-a-wish"><Plus size={16} />{copy.create}</Link>
        </div>
        {state.state === "ready" ? <WishBoard wishes={wishes} copy={copy} /> : null}
        {state.state === "empty" ? <div className="catalog-state"><h2>{copy.emptyTitle}</h2><p>{copy.emptyDescription}</p></div> : null}
        {state.state === "error" ? <div className="catalog-state catalog-state--error"><h2>{copy.errorTitle}</h2><p>{copy.errorDescription}</p></div> : null}
        <div id="make-a-wish" className="wish-submit-section"><WishSubmitForm locale={locale} copy={{ ...copy.form, categories: copy.categories, alsoNeed: copy.alsoNeed }} /></div>
      </div></section>
    </PublicCatalogShell>
  );
}
