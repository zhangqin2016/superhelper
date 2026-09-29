import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEnterpriseOrganization, requireEnterpriseData } from "../../../../../lib/enterprise-page";
import { getI18n } from "../../../../../lib/i18n.mjs";
import { consoleErrorMessage, enterpriseConsoleText, fill, formatDate, formatNumber } from "../../../../../lib/enterprise-console-i18n.mjs";

export const dynamic = "force-dynamic";

/** active | pending | expired | revoked — what a grant can do right now. */
function grantState(grant, now) {
  if (grant.status !== "active") return grant.status === "revoked" ? "revoked" : "disabled";
  if (new Date(grant.expires_at || 0).getTime() <= now) return "expired";
  if (grant.starts_at && new Date(grant.starts_at).getTime() > now) return "pending";
  return "active";
}

export default async function OrgGrantsPage({ params }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id);
  if (!org?.id) notFound();
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const G = T.grants;
  if (org.role !== "owner") {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-8 text-center">
        <h2 className="text-base font-semibold text-slate-900">{T.common.noAccessTitle}</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">{T.common.noAccessBody}</p>
        <Link href={`/account/enterprise/${org.id}`} className="mt-5 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">{T.common.backToOverview}</Link>
      </section>
    );
  }
  const data = await requireEnterpriseData(`/api/enterprise/organizations/${id}/grants`, { grants: [] });
  const grants = Array.isArray(data?.grants) ? data.grants : [];
  const now = Date.now();
  // Only what the pool can spend now: active, started, unexpired Token grants.
  const total = grants.filter((g) => g.resource_type === "token" && grantState(g, now) === "active").reduce((sum, g) => sum + Number(g.unit_remaining || 0), 0);
  const stateTone = { active: "text-emerald-700", pending: "text-sky-700", expired: "text-slate-400", revoked: "text-slate-400", disabled: "text-slate-400" };
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold">{G.title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">{G.intro}</p>
      </header>
      {data?.loadError ? (
        <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-800">{consoleErrorMessage(data.loadError, locale, "load")}</p>
      ) : (
        <>
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-semibold">{formatNumber(total, locale)}</span>
              <span className="text-sm text-slate-500">{G.remaining}</span>
            </div>
          </section>
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            {grants.length === 0 ? (
              <p className="text-sm text-slate-500">{G.empty}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {grants.map((g) => {
                  const state = grantState(g, now);
                  return (
                    <li key={g.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <span className="font-medium">{T.resource[g.resource_type] || g.resource_type}</span>
                        <span className="ms-2 text-sm text-slate-500">{fill(G.remainingOf, { remaining: formatNumber(g.unit_remaining, locale), total: formatNumber(g.unit_total, locale) })}</span>
                      </div>
                      <span className="flex items-center gap-3 text-xs">
                        <span className={stateTone[state]}>{G.state[state]}</span>
                        <span className="text-slate-400">{fill(G.expires, { date: formatDate(g.expires_at, locale) })}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
