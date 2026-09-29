import Link from "next/link";
import { Building2, ChevronRight, Mail } from "lucide-react";
import { requireEnterpriseAccount, requireEnterpriseData } from "../../../lib/enterprise-page";
import { getI18n } from "../../../lib/i18n.mjs";
import { consoleErrorMessage, enterpriseConsoleText, fill, formatNumber, organizationState } from "../../../lib/enterprise-console-i18n.mjs";
import { EnterpriseBadge, EnterpriseSectionError } from "../../../components/enterprise-ui";

export const dynamic = "force-dynamic";

const STATE_TONE = { active: "green", paused: "amber", frozen: "red" };

export default async function EnterprisePage() {
  await requireEnterpriseAccount();
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const data = await requireEnterpriseData("/api/enterprise/organizations", { organizations: [] });
  const orgs = Array.isArray(data?.organizations) ? data.organizations : [];
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{T.list.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-500">{T.list.intro}</p>
      </header>

      {data?.loadError ? <EnterpriseSectionError message={consoleErrorMessage(data.loadError, locale, "load")} /> : null}

      {!data?.loadError && orgs.length === 0 ? (
        <section className="rounded-lg border border-slate-200 bg-white p-8 text-center">
          <Building2 size={28} className="mx-auto text-slate-400" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-semibold">{T.list.emptyTitle}</h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-slate-500">{T.list.emptyBody}</p>
          <Link href="/contact" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
            <Mail size={16} aria-hidden="true" /> {T.list.contactSales}
          </Link>
        </section>
      ) : null}

      {orgs.length > 0 ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {orgs.map((org) => {
            const state = organizationState(org);
            const membershipDisabled = org.membership_status && org.membership_status !== "active";
            return (
              <li key={org.id}>
                <Link href={`/account/enterprise/${org.id}`} className="flex h-full items-center gap-4 rounded-lg border border-slate-200 bg-white p-5 hover:border-slate-300 hover:shadow-sm">
                  <Building2 size={22} className="shrink-0 text-slate-400" aria-hidden="true" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="truncate font-medium text-slate-900">{org.name}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <EnterpriseBadge tone={STATE_TONE[state]}>{T.orgStatus[state]}</EnterpriseBadge>
                      <span>{fill(T.list.myRole, { role: T.roles[org.role] || org.role })}</span>
                      <span aria-hidden="true">·</span>
                      <span>{fill(T.list.memberCount, { n: formatNumber(org.member_count, locale) })}</span>
                    </div>
                    {membershipDisabled ? <p className="text-xs text-red-700">{T.list.membershipDisabled}</p> : null}
                  </div>
                  <span className="flex shrink-0 items-center gap-1 text-sm text-slate-600">
                    {T.list.open}
                    <ChevronRight size={16} className="rtl:rotate-180" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
