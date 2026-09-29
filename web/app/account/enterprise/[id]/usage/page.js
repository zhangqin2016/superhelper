import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEnterpriseOrganization, requireEnterpriseData, roleAtLeast } from "../../../../../lib/enterprise-page";
import { getI18n } from "../../../../../lib/i18n.mjs";
import { consoleErrorMessage, enterpriseConsoleText, fill, formatNumber, personDetail, personLabel } from "../../../../../lib/enterprise-console-i18n.mjs";
import { EnterpriseCard, EnterpriseEmpty, EnterpriseNoAccess, EnterpriseSectionError } from "../../../../../components/enterprise-ui";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = [7, 30, 90, 365];

/** A hand-typed ?days=abc falls back to 30 instead of blanking the page. */
function parseDays(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
}

function share(part, whole) {
  const total = Number(whole || 0);
  if (!total) return "—";
  return `${Math.round((Number(part || 0) / total) * 1000) / 10}%`;
}

export default async function OrgUsagePage({ params, searchParams }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id);
  if (!org?.id) notFound();
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const U = T.usage;
  const base = `/account/enterprise/${org.id}`;
  if (!roleAtLeast(org.role, "admin")) {
    return <EnterpriseNoAccess title={T.common.noAccessTitle} body={T.common.noAccessBody} href={base} linkLabel={T.common.backToOverview} />;
  }
  const query = (await searchParams) || {};
  const days = parseDays(query.days);
  const data = await requireEnterpriseData(`/api/enterprise/organizations/${encodeURIComponent(id)}/usage?days=${days}`, { usage: {} });
  const usage = data?.usage || {};
  const byMember = Array.isArray(usage.byMember) ? usage.byMember : [];
  const byModel = Array.isArray(usage.byModel) ? usage.byModel : [];
  const totals = usage.totals || {
    requests: byMember.reduce((s, r) => s + Number(r.request_count || 0), 0),
    units: byMember.reduce((s, r) => s + Number(r.units || 0), 0),
    tokens: byMember.reduce((s, r) => s + Number(r.tokens || 0), 0),
  };
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{U.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">{U.intro}</p>
        </div>
        <nav className="flex shrink-0 gap-1 rounded-lg border border-slate-200 bg-white p-1" aria-label={fill(U.range, { n: days })}>
          {DAY_OPTIONS.map((d) => (
            <Link
              key={d}
              href={`${base}/usage?days=${d}`}
              aria-current={d === days ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm ${d === days ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {fill(U.days, { n: d })}
            </Link>
          ))}
        </nav>
      </header>

      {data?.loadError ? <EnterpriseSectionError message={consoleErrorMessage(data.loadError, locale, "load")} /> : (
        <>
          <dl className="grid gap-4 sm:grid-cols-3">
            {[[U.requests, totals.requests], [U.units, totals.units], [U.tokens, totals.tokens]].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-200 bg-white p-5">
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(value, locale)}</dd>
                <dd className="mt-1 text-xs text-slate-400">{fill(U.range, { n: days })}</dd>
              </div>
            ))}
          </dl>

          <EnterpriseCard title={U.byMember}>
            {byMember.length === 0 ? <EnterpriseEmpty>{U.empty}</EnterpriseEmpty> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500">
                      <th className="py-2 pe-4 text-start font-medium">{U.colMember}</th>
                      <th className="py-2 pe-4 text-end font-medium">{U.requests}</th>
                      <th className="py-2 pe-4 text-end font-medium">{U.units}</th>
                      <th className="py-2 pe-4 text-end font-medium">{U.tokens}</th>
                      <th className="py-2 text-end font-medium">{U.colShare}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byMember.map((row, index) => (
                      <tr key={row.user_id || index} className="border-t border-slate-100">
                        <td className="py-2 pe-4">
                          <span className="block font-medium text-slate-900">{personLabel(row, U.formerMember)}</span>
                          {personDetail(row) ? <span className="block text-xs text-slate-500"><bdi>{personDetail(row)}</bdi></span> : null}
                        </td>
                        <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(row.request_count, locale)}</td>
                        <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(row.units, locale)}</td>
                        <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(row.tokens, locale)}</td>
                        <td className="py-2 text-end tabular-nums text-slate-500">{share(row.units, totals.units)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </EnterpriseCard>

          <EnterpriseCard title={U.byModel}>
            {byModel.length === 0 ? <EnterpriseEmpty>{U.empty}</EnterpriseEmpty> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500">
                      <th className="py-2 pe-4 text-start font-medium">{U.colModel}</th>
                      <th className="py-2 pe-4 text-end font-medium">{U.requests}</th>
                      <th className="py-2 pe-4 text-end font-medium">{U.units}</th>
                      <th className="py-2 text-end font-medium">{U.colShare}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map((row, index) => (
                      <tr key={row.model || index} className="border-t border-slate-100">
                        <td className="py-2 pe-4 font-mono text-xs text-slate-800"><bdi>{row.model || "—"}</bdi></td>
                        <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(row.request_count, locale)}</td>
                        <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(row.units, locale)}</td>
                        <td className="py-2 text-end tabular-nums text-slate-500">{share(row.units, totals.units)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </EnterpriseCard>
        </>
      )}
    </div>
  );
}
