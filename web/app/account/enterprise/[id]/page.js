import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart3, CalendarClock, Coins, History, LogOut, Settings, Users, Wallet } from "lucide-react";
import { requireEnterpriseOrganization } from "../../../../lib/enterprise-page";
import { getI18n } from "../../../../lib/i18n.mjs";
import { consoleErrorMessage, enterpriseConsoleText, fill, formatBudget, formatDate, formatDateTime, formatNumber } from "../../../../lib/enterprise-console-i18n.mjs";

export const dynamic = "force-dynamic";

const isAdmin = (role) => role === "owner" || role === "admin";

/** What the pool can spend now: active, unexpired grants, per resource type. */
function poolSummary(quota) {
  const now = Date.now();
  const live = (Array.isArray(quota) ? quota : []).filter((g) => g && g.status === "active" && new Date(g.expires_at || 0).getTime() > now && Number(g.unit_remaining || 0) > 0);
  const byType = {};
  for (const grant of live) byType[grant.resource_type] = (byType[grant.resource_type] || 0) + Number(grant.unit_remaining || 0);
  const nextExpiry = live.map((g) => new Date(g.expires_at).getTime()).sort((a, b) => a - b)[0] || null;
  return { byType, nextExpiry, empty: live.length === 0 };
}

function MyWeek({ me, T, locale }) {
  const O = T.overview;
  if (!me || me.ok === false) {
    return (
      <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {O.myWeekUnavailable} {me?.code ? consoleErrorMessage(me.code, locale, "load") : ""}
      </p>
    );
  }
  const unlimited = me.weeklyBudget === null || me.weeklyBudget === undefined;
  const budget = Number(me.weeklyBudget || 0);
  const used = Number(me.weeklyUsed || 0);
  const percent = unlimited || budget <= 0 ? (unlimited ? 0 : 100) : Math.min(100, Math.round((used / budget) * 100));
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-slate-500">{O.used}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(used, locale)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">{O.budget}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatBudget(me.weeklyBudget, locale)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">{O.resets}</dt>
          <dd className="mt-1 text-sm font-medium text-slate-800">{me.resetsAt ? formatDateTime(me.resetsAt, locale) : O.notStarted}</dd>
        </div>
      </dl>
      {!unlimited ? (
        <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className={`h-full rounded-full ${me.limited ? "bg-red-500" : percent >= 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {me.limited ? <p className="text-sm font-medium text-red-700">{O.limitedNote}</p> : null}
      {unlimited ? <p className="text-sm text-slate-600">{O.unlimitedNote}</p> : null}
      <p className="text-xs text-slate-500">{O.weekExplain}</p>
      {me.perRequestCap !== null && me.perRequestCap !== undefined ? <p className="text-xs text-slate-500">{fill(O.perRequestCap, { n: formatNumber(me.perRequestCap, locale) })}</p> : null}
    </div>
  );
}

export default async function OrgOverviewPage({ params }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id);
  if (!org?.id) notFound();
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const O = T.overview;
  const base = `/account/enterprise/${org.id}`;
  const admin = isAdmin(org.role);
  const pool = admin ? poolSummary(org.quota) : null;
  const others = pool ? Object.entries(pool.byType).filter(([type]) => type !== "token").map(([type, n]) => `${T.resource[type] || type} ${formatNumber(n, locale)}`) : [];
  const links = [
    ...(admin ? [
      { href: `${base}/members`, icon: Users, label: O.linkMembers, desc: O.linkMembersDesc },
      { href: `${base}/usage`, icon: BarChart3, label: O.linkUsage, desc: O.linkUsageDesc },
      { href: `${base}/history`, icon: History, label: O.linkHistory, desc: O.linkHistoryDesc },
    ] : []),
    ...(org.role === "owner" ? [{ href: `${base}/grants`, icon: Coins, label: O.linkPool, desc: O.linkPoolDesc }] : []),
    admin
      ? { href: `${base}/settings`, icon: Settings, label: O.linkSettings, desc: O.linkSettingsDesc }
      : { href: `${base}/settings`, icon: LogOut, label: O.linkLeave, desc: O.linkLeaveDesc },
  ];
  return (
    <div className="space-y-6">
      <h2 className="sr-only">{org.name}</h2>
      <div className="grid gap-6 lg:grid-cols-5">
        <section className="rounded-lg border border-slate-200 bg-white p-6 lg:col-span-3">
          <h3 className="mb-4 flex items-center gap-2 text-base font-semibold text-slate-900">
            <CalendarClock size={18} className="text-brand" aria-hidden="true" /> {O.myWeekTitle}
          </h3>
          <MyWeek me={org.me} T={T} locale={locale} />
        </section>
        <section className="rounded-lg border border-slate-200 bg-white p-6 lg:col-span-2">
          <h3 className="mb-3 flex items-center gap-2 text-base font-semibold text-slate-900">
            <Wallet size={18} className="text-brand" aria-hidden="true" /> {O.whoPaysTitle}
          </h3>
          <p className="text-sm leading-6 text-slate-600">{O.whoPaysBody}</p>
        </section>
      </div>

      {pool ? (
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Coins size={18} className="text-brand" aria-hidden="true" /> {O.poolTitle}
            </h3>
            {org.role === "owner" ? <Link href={`${base}/grants`} className="text-sm text-slate-600 underline hover:text-slate-900">{O.poolDetails}</Link> : null}
          </div>
          {pool.empty ? (
            <p className="mt-3 text-sm font-medium text-amber-800">{O.poolEmpty}</p>
          ) : (
            <div className="mt-3 space-y-1">
              <p className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums">{formatNumber(pool.byType.token || 0, locale)}</span>
                <span className="text-sm text-slate-500">{O.poolRemaining}</span>
              </p>
              {others.length ? <p className="text-sm text-slate-600">{fill(O.poolOther, { items: others.join(" · ") })}</p> : null}
              {pool.nextExpiry ? <p className="text-xs text-slate-500">{fill(O.poolExpires, { date: formatDate(pool.nextExpiry, locale) })}</p> : null}
            </div>
          )}
          <p className="mt-4 text-xs text-slate-500">{O.poolTopup}</p>
        </section>
      ) : null}

      <section>
        <h3 className="mb-3 text-sm font-semibold text-slate-700">{O.shortcutsTitle}</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {links.map(({ href, icon: Icon, label, desc }) => (
            <Link key={href} href={href} className="rounded-lg border border-slate-200 bg-white p-5 hover:border-slate-300 hover:shadow-sm">
              <span className="flex items-center gap-2 font-medium text-slate-900">
                <Icon size={18} className="text-brand" aria-hidden="true" /> {label}
              </span>
              <span className="mt-2 block text-sm text-slate-500">{desc}</span>
            </Link>
          ))}
        </div>
        {!admin ? <p className="mt-4 text-sm text-slate-500">{O.memberHint}</p> : null}
      </section>
    </div>
  );
}
