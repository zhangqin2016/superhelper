import Link from "next/link";
import { Plus } from "lucide-react";
import { PublicCatalogShell } from "../../components/public-catalog-shell";
import { WishBoard } from "../../components/wish-board";
import { publicApiGet } from "../../lib/public-api";
import { classifyWishResult, normalizePublicWishes, wishQuery } from "../../lib/public-wishes.mjs";
import { getI18n } from "../../lib/i18n.mjs";

export const metadata = { title: "许愿池 · Lily Workbench", description: "一起决定 Lily 下一步学会什么。" };
export const dynamic = "force-dynamic";

export default async function WishesPage({ searchParams }) {
  const { locale, t } = await getI18n();
  const params = await searchParams;
  const query = wishQuery({ status: params?.status, category: params?.category, sort: params?.sort, locale });
  const result = await publicApiGet(`/api/wishes${query}`);
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
          <Link className="wish-create-link" href="/account/login?next=/wishes"><Plus size={16} />{copy.create}</Link>
        </div>
        {state.state === "ready" ? <WishBoard wishes={wishes} copy={copy} /> : null}
        {state.state === "empty" ? <div className="catalog-state"><h2>{copy.emptyTitle}</h2><p>{copy.emptyDescription}</p></div> : null}
        {state.state === "error" ? <div className="catalog-state catalog-state--error"><h2>{copy.errorTitle}</h2><p>{copy.errorDescription}</p></div> : null}
      </div></section>
    </PublicCatalogShell>
  );
}
