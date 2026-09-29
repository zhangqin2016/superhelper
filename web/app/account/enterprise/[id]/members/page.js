import Link from "next/link";
import { notFound } from "next/navigation";
import { Search, UserPlus } from "lucide-react";
import { requireEnterpriseOrganization, requireEnterpriseData, roleAtLeast } from "../../../../../lib/enterprise-page";
import { getI18n } from "../../../../../lib/i18n.mjs";
import {
  consoleErrorMessage, enterpriseConsoleText, fill, formatBudget, formatDate, formatDateTime, formatNumber, personDetail, personLabel,
} from "../../../../../lib/enterprise-console-i18n.mjs";
import {
  addMemberAction, patchMemberAction, provisionAccountsAction, removeMemberAction, resetAccountPasswordAction,
  restoreAccountAction, revokeInvitationAction, setMemberStatusAction,
} from "../../actions";
import EnterpriseActionForm from "../../../../../components/enterprise-action-form";
import { EnterpriseBadge, EnterpriseCard, EnterpriseEmpty, EnterpriseNoAccess, EnterpriseSectionError } from "../../../../../components/enterprise-ui";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const input = "rounded-lg border border-slate-200 px-3 py-2 text-sm";
const primary = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700";
const secondary = "rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200";
const danger = "rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-700 hover:bg-red-100";

/** +8613800138000 -> +86 138****8000: enough to recognise, not a full number on screen. */
function maskPhone(phone) {
  const text = String(phone || "");
  const match = /^\+86(\d{3})\d{4}(\d{4})$/.exec(text);
  return match ? `+86 ${match[1]}****${match[2]}` : text.replace(/\d(?=\d{4})/g, (d, i) => (i > 3 ? "*" : d));
}

/**
 * What this viewer may do to this member — the server's rules, mirrored so a
 * control that would only earn a refusal is not offered: admins act on plain
 * members (and their own budget), owners on everyone; nobody disables,
 * removes or re-roles themselves here.
 */
function permissions(viewer, member) {
  const self = member.user_id === viewer.viewerId;
  const reach = viewer.role === "owner" || member.role === "member" || self;
  return {
    self,
    reach,
    budget: reach,
    role: reach && !self && member.role !== "owner",
    status: reach && !self,
    remove: reach && !self,
  };
}

function WeekCell({ member, T, locale }) {
  const M = T.members;
  const budget = member.effectiveWeeklyBudget;
  const used = formatNumber(member.weeklyUsed, locale);
  const unlimited = budget === null || budget === undefined;
  const over = !unlimited && Number(member.weeklyUsed || 0) >= Number(budget);
  return (
    <div className="space-y-0.5 text-xs">
      <p className={`tabular-nums ${over ? "font-medium text-red-700" : "text-slate-800"}`}>
        {unlimited ? fill(M.usedUnlimited, { used }) : fill(M.usedOf, { used, budget: formatNumber(budget, locale) })}
      </p>
      <p className="text-slate-500">{member.weeklyResetsAt ? fill(M.resetsAt, { date: formatDateTime(member.weeklyResetsAt, locale) }) : M.notStarted}</p>
      <p className="text-slate-400">{member.weeklyBudget === null || member.weeklyBudget === undefined ? M.orgDefault : M.ownBudget}</p>
    </div>
  );
}

function MemberRow({ org, member, T, locale }) {
  const M = T.members;
  const can = permissions(org, member);
  const name = personLabel(member, T.history.someone);
  const detail = personDetail(member);
  const id = org.id;
  return (
    <li className="grid gap-3 px-6 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
          <span className="truncate">{name}</span>
          {can.self ? <EnterpriseBadge tone="blue">{T.common.you}</EnterpriseBadge> : null}
          <EnterpriseBadge tone={member.role === "owner" ? "blue" : "slate"}>{T.roles[member.role] || member.role}</EnterpriseBadge>
          {member.issued ? <EnterpriseBadge>{M.issuedBadge}</EnterpriseBadge> : null}
          {member.status !== "active" ? <EnterpriseBadge tone="red">{T.memberStatus[member.status] || member.status}</EnterpriseBadge> : null}
        </p>
        {detail ? <p className="mt-0.5 text-xs text-slate-500"><bdi>{detail}</bdi></p> : null}
        <p className="mt-0.5 text-xs text-slate-400">
          {member.lastLoginAt ? fill(M.lastLogin, { date: formatDate(member.lastLoginAt, locale) }) : M.neverLoggedIn}
        </p>
      </div>
      <WeekCell member={member} T={T} locale={locale} />
      <div className="flex flex-wrap items-start gap-2 md:justify-end">
        {can.budget ? (
          <details className="group w-full rounded-lg border border-slate-200 open:bg-slate-50 md:w-auto">
            <summary className="cursor-pointer select-none px-3 py-1.5 text-sm text-slate-700">{M.edit}</summary>
            <EnterpriseActionForm action={patchMemberAction.bind(null, id, member.user_id)} locale={locale} className="flex flex-col gap-3 p-3 md:w-80">
              <input type="hidden" name="roleWas" value={member.role || ""} />
              <input type="hidden" name="weeklyBudgetWas" value={member.weeklyBudget ?? ""} />
              <input type="hidden" name="quotaWas" value={member.quota ?? ""} />
              {can.role ? (
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  {M.roleLabel}
                  <select name="role" defaultValue={member.role} className={input}>
                    <option value="member">{T.roles.member}</option>
                    <option value="admin">{T.roles.admin}</option>
                  </select>
                </label>
              ) : member.role === "owner" ? <p className="text-xs text-slate-500">{M.ownerRoleHint}</p> : null}
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                {M.budgetLabel}
                <input name="weeklyBudget" type="number" min="0" step="1" inputMode="numeric" defaultValue={member.weeklyBudget ?? ""} placeholder={M.budgetPlaceholder} className={input} />
                <span className="text-slate-400">{M.budgetHelp}</span>
              </label>
              <details className="text-xs text-slate-600">
                <summary className="cursor-pointer select-none">{M.capLabel}</summary>
                <label className="mt-2 flex flex-col gap-1">
                  <input name="quota" type="number" min="0" step="1" inputMode="numeric" defaultValue={member.quota ?? ""} placeholder={M.capPlaceholder} aria-label={M.capLabel} className={input} />
                  <span className="text-slate-400">{M.capHelp}</span>
                </label>
              </details>
              <button type="submit" className={primary}>{T.common.save}</button>
            </EnterpriseActionForm>
          </details>
        ) : null}
        {can.status && member.status === "active" ? (
          <EnterpriseActionForm action={setMemberStatusAction.bind(null, id, member.user_id, "disabled")} locale={locale} confirm={M.confirmDisable} confirmName={name} className="flex flex-wrap items-center gap-2">
            <button type="submit" className={secondary}>{M.disable}</button>
          </EnterpriseActionForm>
        ) : null}
        {can.status && member.status !== "active" ? (
          <EnterpriseActionForm action={setMemberStatusAction.bind(null, id, member.user_id, "active")} locale={locale} className="flex flex-wrap items-center gap-2">
            <button type="submit" className={secondary}>{M.enable}</button>
          </EnterpriseActionForm>
        ) : null}
        {can.remove ? (
          <EnterpriseActionForm action={removeMemberAction.bind(null, id, member.user_id)} locale={locale} confirm={M.confirmRemove} confirmName={name} className="flex flex-wrap items-center gap-2">
            <button type="submit" className={danger}>{M.remove}</button>
          </EnterpriseActionForm>
        ) : null}
        {can.self ? <p className="basis-full text-xs text-slate-400 md:text-end">{M.selfHint}</p> : null}
        {!can.reach ? <p className="basis-full text-xs text-slate-400 md:text-end">{M.peerHint}</p> : null}
      </div>
    </li>
  );
}

function pageLink(base, q, offset) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export default async function OrgMembersPage({ params, searchParams }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id);
  if (!org?.id) notFound();
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const M = T.members;
  const base = `/account/enterprise/${org.id}`;
  if (!roleAtLeast(org.role, "admin")) {
    return <EnterpriseNoAccess title={T.common.noAccessTitle} body={T.common.noAccessBody} href={base} linkLabel={T.common.backToOverview} />;
  }
  const query = (await searchParams) || {};
  const q = String(query.q || "").trim().slice(0, 80);
  const offset = Math.max(0, Math.trunc(Number(query.offset) || 0));
  const api = `/api/enterprise/organizations/${encodeURIComponent(id)}`;
  const listQuery = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), ...(q ? { q } : {}) });
  // Three independent reads: one failing degrades its own section only.
  const [memberData, invitationData, accountData] = await Promise.all([
    requireEnterpriseData(`${api}/members?${listQuery}`, { members: [], total: 0 }),
    requireEnterpriseData(`${api}/invitations`, { invitations: [] }),
    requireEnterpriseData(`${api}/accounts`, { accounts: [] }),
  ]);
  const members = Array.isArray(memberData?.members) ? memberData.members : [];
  const total = Number(memberData?.total ?? members.length) || 0;
  const invitations = Array.isArray(invitationData?.invitations) ? invitationData.invitations : [];
  const accounts = Array.isArray(accountData?.accounts) ? accountData.accounts : [];
  const now = Date.now();
  const I = T.invitations;
  const A = T.accounts;
  const from = total ? offset + 1 : 0;
  const to = offset + members.length;
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold">{M.title}</h2>
        <p className="mt-1 text-sm text-slate-500">{M.intro}</p>
        <p className="mt-1 text-sm text-slate-600">{fill(M.defaultBudget, { value: formatBudget(org.default_member_weekly_budget, locale) })}</p>
      </header>

      <EnterpriseCard title={M.addTitle} description={M.addIntro}>
        <EnterpriseActionForm action={addMemberAction.bind(null, id)} locale={locale} className="flex flex-wrap items-start gap-3">
          <input name="phoneE164" inputMode="tel" autoComplete="off" placeholder={M.phonePlaceholder} aria-label={M.phonePlaceholder} className={`${input} min-w-0 flex-1 basis-56`} />
          <select name="role" defaultValue="member" aria-label={M.roleLabel} className={input}>
            <option value="member">{T.roles.member}</option>
            <option value="admin">{T.roles.admin}</option>
          </select>
          <button type="submit" className={`${primary} inline-flex items-center gap-2`}><UserPlus size={16} aria-hidden="true" /> {M.addButton}</button>
          <details className="basis-full text-xs text-slate-500">
            <summary className="cursor-pointer select-none">{M.userIdToggle}</summary>
            <input name="userId" autoComplete="off" placeholder={M.userIdPlaceholder} aria-label={M.userIdPlaceholder} dir="ltr" className={`${input} mt-2 w-full sm:w-80`} />
          </details>
        </EnterpriseActionForm>
      </EnterpriseCard>

      <section className="rounded-lg border border-slate-200 bg-white">
        <form method="get" className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-6 py-4" role="search">
          <Search size={16} className="text-slate-400" aria-hidden="true" />
          <input name="q" defaultValue={q} placeholder={M.searchPlaceholder} aria-label={M.searchPlaceholder} className={`${input} min-w-0 flex-1`} />
          <button type="submit" className={secondary}>{T.common.search}</button>
          {q ? <Link href={base + "/members"} className="text-sm text-slate-500 underline">{T.common.clear}</Link> : null}
        </form>
        {memberData?.loadError ? (
          <div className="p-6"><EnterpriseSectionError message={consoleErrorMessage(memberData.loadError, locale, "load")} /></div>
        ) : members.length === 0 ? (
          <div className="p-6"><EnterpriseEmpty>{q ? fill(M.emptySearch, { q }) : M.empty}</EnterpriseEmpty></div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {members.map((member) => <MemberRow key={member.user_id} org={org} member={member} T={T} locale={locale} />)}
          </ul>
        )}
        {!memberData?.loadError && total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
            <span>{fill(T.common.range, { from: formatNumber(from, locale), to: formatNumber(to, locale), total: formatNumber(total, locale) })}</span>
            <span className="flex gap-2">
              {offset > 0 ? <Link href={pageLink(`${base}/members`, q, Math.max(0, offset - PAGE_SIZE))} className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50">{T.common.prev}</Link> : null}
              {to < total ? <Link href={pageLink(`${base}/members`, q, offset + PAGE_SIZE)} className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50">{T.common.next}</Link> : null}
            </span>
          </div>
        ) : null}
      </section>

      <EnterpriseCard title={fill(I.title, { n: formatNumber(invitations.length, locale) })} description={I.intro}>
        {invitationData?.loadError ? <EnterpriseSectionError message={consoleErrorMessage(invitationData.loadError, locale, "load")} /> : invitations.length === 0 ? (
          <EnterpriseEmpty>{I.empty}</EnterpriseEmpty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {invitations.map((invitation) => {
              const expired = invitation.expires_at && new Date(invitation.expires_at).getTime() <= now;
              return (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900"><bdi>{maskPhone(invitation.phone_e164)}</bdi></p>
                    <p className="text-xs text-slate-500">
                      {T.roles[invitation.role] || invitation.role} · {fill(I.addedAt, { date: formatDate(invitation.created_at, locale) })} · {expired ? I.expired : invitation.expires_at ? fill(I.expiresAt, { date: formatDate(invitation.expires_at, locale) }) : ""}
                    </p>
                  </div>
                  <EnterpriseActionForm action={revokeInvitationAction.bind(null, id, invitation.id)} locale={locale} confirm={I.confirmRevoke} confirmName={maskPhone(invitation.phone_e164)} className="flex flex-wrap items-center gap-2">
                    <button type="submit" className={danger}>{I.revoke}</button>
                  </EnterpriseActionForm>
                </li>
              );
            })}
          </ul>
        )}
      </EnterpriseCard>

      <EnterpriseCard title={fill(A.title, { n: formatNumber(accounts.length, locale) })} description={A.intro}>
        <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-900">{A.provisionTitle}</h3>
          <p className="mt-1 text-xs text-slate-500">{A.provisionIntro}</p>
          <EnterpriseActionForm action={provisionAccountsAction.bind(null, id)} locale={locale} className="mt-3 flex flex-wrap items-start gap-3">
            <input name="prefix" placeholder={A.prefixPlaceholder} aria-label={A.prefixPlaceholder} dir="ltr" className={`${input} w-40`} />
            <input name="count" type="number" min="1" max="100" placeholder={A.countPlaceholder} aria-label={A.countPlaceholder} className={`${input} w-24`} />
            <textarea name="loginNames" rows={1} placeholder={A.loginNamesPlaceholder} aria-label={A.loginNamesPlaceholder} className={`${input} min-w-0 flex-1 basis-56`} />
            <select name="role" defaultValue="member" aria-label={M.roleLabel} className={input}>
              <option value="member">{T.roles.member}</option>
              <option value="admin">{T.roles.admin}</option>
            </select>
            <button type="submit" className={primary}>{A.submit}</button>
          </EnterpriseActionForm>
        </div>
        {accountData?.loadError ? <EnterpriseSectionError message={consoleErrorMessage(accountData.loadError, locale, "load")} /> : accounts.length === 0 ? (
          <EnterpriseEmpty>{A.empty}</EnterpriseEmpty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {accounts.map((account) => {
              const removed = account.memberStatus === "removed";
              const self = account.userId === org.viewerId;
              const canReset = !removed && !self && (org.role === "owner" || account.role === "member");
              return (
                <li key={account.userId} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                      <bdi className="font-mono">{account.loginName}</bdi>
                      {account.displayName ? <span className="font-normal text-slate-500">{account.displayName}</span> : null}
                      {account.role && !removed ? <EnterpriseBadge>{T.roles[account.role] || account.role}</EnterpriseBadge> : null}
                      {account.memberStatus !== "active" ? <EnterpriseBadge tone={removed ? "slate" : "red"}>{T.memberStatus[account.memberStatus] || account.memberStatus}</EnterpriseBadge> : null}
                    </p>
                    <p className="text-xs text-slate-500">
                      {removed ? A.removedHint : account.passwordMustChange ? A.notFirstLogin : account.lastLoginAt ? fill(M.lastLogin, { date: formatDate(account.lastLoginAt, locale) }) : M.neverLoggedIn}
                    </p>
                  </div>
                  {removed ? (
                    <EnterpriseActionForm action={restoreAccountAction.bind(null, id, account.userId)} locale={locale} className="flex flex-wrap items-center gap-2">
                      <button type="submit" className={secondary}>{A.restore}</button>
                    </EnterpriseActionForm>
                  ) : null}
                  {canReset ? (
                    <EnterpriseActionForm action={resetAccountPasswordAction.bind(null, id, account.userId)} locale={locale} confirm={A.confirmReset} confirmName={account.loginName} className="flex flex-wrap items-center gap-2">
                      <button type="submit" className={secondary}>{A.resetPassword}</button>
                    </EnterpriseActionForm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </EnterpriseCard>
    </div>
  );
}
