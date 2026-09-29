import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEnterpriseOrganization, requireEnterpriseData, roleAtLeast } from "../../../../../lib/enterprise-page";
import { getI18n } from "../../../../../lib/i18n.mjs";
import { consoleErrorMessage, enterpriseConsoleText, fill, formatBudget, formatDateTime, formatNumber, personLabel } from "../../../../../lib/enterprise-console-i18n.mjs";
import { EnterpriseCard, EnterpriseEmpty, EnterpriseNoAccess, EnterpriseSectionError } from "../../../../../components/enterprise-ui";

export const dynamic = "force-dynamic";

const STEP = 50;
const MAX_SHOWN = 1000;

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

/**
 * One entry as a sentence: who did what to whom. People are named from the
 * roster (display name / login name / masked phone); someone no longer in it
 * is "a former member" — never a bare usr_ id.
 */
function describe(entry, people, T, locale) {
  const H = T.history;
  const meta = parseMetadata(entry.metadata);
  const actor = entry.actor?.kind === "platform" ? H.platform : personLabel(entry.actor, H.someone);
  const who = (userId) => (userId && people.get(userId)) || H.formerMember;
  const role = (value) => T.roles[value] || value || T.roles.member;
  const budget = (value) => (value === null || value === undefined ? T.common.unlimited : formatNumber(value, locale));
  const changes = [];
  if (entry.action === "enterprise_member_change") {
    if (meta.memberRole !== undefined) changes.push(fill(H.changes.role, { from: role(meta.previousRole), to: role(meta.memberRole) }));
    if (meta.status !== undefined) changes.push(fill(H.changes.status, { status: T.memberStatus[meta.status] || meta.status }));
    if (meta.weeklyBudget !== undefined) changes.push(meta.weeklyBudget === null ? H.changes.weeklyBudgetDefault : fill(H.changes.weeklyBudget, { value: budget(meta.weeklyBudget) }));
    if (meta.memberQuota !== undefined) changes.push(fill(H.changes.memberQuota, { value: budget(meta.memberQuota) }));
  }
  if (entry.action === "enterprise_org_change") {
    if (meta.name !== undefined) changes.push(fill(H.changes.name, { value: meta.name }));
    if (meta.ownerStatus !== undefined) changes.push(meta.ownerStatus === "disabled" ? H.changes.paused : H.changes.resumed);
    if (meta.defaultMemberWeeklyBudget !== undefined) changes.push(fill(H.changes.defaultBudget, { value: formatBudget(meta.defaultMemberWeeklyBudget, locale) }));
    if (meta.reason) changes.push(fill(H.changes.reason, { value: meta.reason }));
  }
  let key = entry.action;
  if (entry.action === "enterprise_org_status") key = meta.platformStatus === "active" ? "enterprise_org_unfrozen" : "enterprise_org_frozen";
  const template = H.actions[key] || H.actions.unknown;
  const target = entry.action === "enterprise_owner_transfer" ? who(meta.toUserId) : who(meta.userId);
  const sentence = fill(template, {
    actor,
    target,
    role: role(meta.memberRole || meta.invitedRole),
    count: formatNumber(meta.count ?? (Array.isArray(meta.userIds) ? meta.userIds.length : 0), locale),
    units: formatNumber(meta.units ?? meta.unitTotal ?? 0, locale),
    type: T.resource[meta.resourceType] || "",
    changes: changes.length ? changes.join(H.joiner) : H.changes.nothing,
  });
  const note = entry.action === "enterprise_org_status" && meta.reason ? fill(H.changes.reason, { value: meta.reason }) : "";
  return { sentence, note };
}

export default async function OrgHistoryPage({ params, searchParams }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id);
  if (!org?.id) notFound();
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const H = T.history;
  const base = `/account/enterprise/${org.id}`;
  if (!roleAtLeast(org.role, "admin")) {
    return <EnterpriseNoAccess title={T.common.noAccessTitle} body={T.common.noAccessBody} href={base} linkLabel={T.common.backToOverview} />;
  }
  const query = (await searchParams) || {};
  const want = Math.min(MAX_SHOWN, Math.max(STEP, Math.trunc(Number(query.show) || STEP)));
  const api = `/api/enterprise/organizations/${encodeURIComponent(id)}`;
  // "Load more" grows the list in place: walk the cursor until `want` rows.
  const entries = [];
  let before = null;
  let loadError = "";
  let more = true;
  while (more && entries.length < want) {
    const limit = Math.min(200, want - entries.length);
    const page = await requireEnterpriseData(`${api}/audit?limit=${limit}${before ? `&before=${before}` : ""}`, { entries: [], nextBefore: null });
    if (page.loadError) { loadError = page.loadError; break; }
    entries.push(...(Array.isArray(page.entries) ? page.entries : []));
    before = page.nextBefore;
    more = Boolean(before);
  }
  // Names for the people entries point at (they carry only an id).
  const [roster, accounts] = await Promise.all([
    requireEnterpriseData(`${api}/members?limit=500`, { members: [] }),
    requireEnterpriseData(`${api}/accounts`, { accounts: [] }),
  ]);
  const people = new Map();
  for (const account of Array.isArray(accounts.accounts) ? accounts.accounts : []) people.set(account.userId, personLabel(account));
  for (const member of Array.isArray(roster.members) ? roster.members : []) people.set(member.user_id, personLabel(member));
  for (const entry of entries) if (entry.actor?.userId) people.set(entry.actor.userId, personLabel(entry.actor) || people.get(entry.actor.userId));
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold">{H.title}</h2>
        <p className="mt-1 text-sm text-slate-500">{H.intro}</p>
      </header>
      <EnterpriseCard>
        {loadError && entries.length === 0 ? <EnterpriseSectionError message={consoleErrorMessage(loadError, locale, "load")} /> : entries.length === 0 ? (
          <EnterpriseEmpty>{H.empty}</EnterpriseEmpty>
        ) : (
          <ol className="relative space-y-4 border-s border-slate-200 ps-5">
            {entries.map((entry) => {
              const { sentence, note } = describe(entry, people, T, locale);
              return (
                <li key={entry.id} className="relative">
                  <span className={`absolute -start-[25px] top-1.5 h-2.5 w-2.5 rounded-full ${entry.actor?.kind === "platform" ? "bg-sky-500" : "bg-slate-400"}`} aria-hidden="true" />
                  <p className="text-sm text-slate-900">{sentence}</p>
                  {note ? <p className="text-xs text-slate-500">{note}</p> : null}
                  <p className="mt-0.5 text-xs text-slate-400"><time dateTime={String(entry.createdAt || "")}>{formatDateTime(entry.createdAt, locale)}</time></p>
                </li>
              );
            })}
          </ol>
        )}
        {entries.length > 0 ? (
          <div className="mt-6 flex items-center justify-center">
            {loadError ? <EnterpriseSectionError message={consoleErrorMessage(loadError, locale, "load")} /> : more && want < MAX_SHOWN ? (
              <Link href={`${base}/history?show=${want + STEP}`} scroll={false} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">{H.loadMore}</Link>
            ) : !more ? <span className="text-xs text-slate-400">{H.end}</span> : null}
          </div>
        ) : null}
      </EnterpriseCard>
    </div>
  );
}
