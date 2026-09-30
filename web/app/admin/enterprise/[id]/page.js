import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { Badge } from "../../../../components/ui/badge";
import { EnterpriseActionForm, EnterpriseDangerForm } from "../../../../components/admin-enterprise-form";
import { GrantQuotaForm, GrantRowActions } from "../../../../components/admin-enterprise-grants";
import { OrgStatusBadge, fill, formatAmount, formatDate, formatNumber, orgStatus, personLabel } from "../../../../components/admin-enterprise-shared";
import { apiGet, loadAdmin } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";
import {
  freezeOrganizationAction,
  grantOrganizationQuotaAction,
  reduceGrantAction,
  reissueOwnerInitialPasswordAction,
  renameOrganizationAction,
  revokeGrantAction,
  setDefaultWeeklyBudgetAction,
  unfreezeOrganizationAction,
} from "../actions";

export const dynamic = "force-dynamic";

const RESOURCES = ["token", "image_generation", "video_generation"];
const USAGE_DAYS = [7, 30, 90];
const REDUCIBLE = new Set(["active", "scheduled"]);
const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand";

function Section({ id, title, help, children, aside = null }) {
  return (
    <section id={id} className="table-card mb-4 scroll-mt-4 p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
          {help ? <p className="mt-1 max-w-3xl text-sm text-slate-500">{help}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function SimpleTable({ headers, children }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-start text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>{headers.map((header, index) => <th key={index} className="whitespace-nowrap px-4 py-2 text-start font-medium">{header}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

/** One history row's metadata as "field: value" pairs a person can read. */
function describeMetadata(metadata, e, locale) {
  const h = e.history;
  const out = [];
  const resource = metadata.resourceType;
  for (const [key, raw] of Object.entries(metadata)) {
    const label = h.fields[key];
    if (!label || raw === undefined) continue;
    let value = raw;
    if (key === "platformStatus" || key === "ownerStatus" || key === "status") value = h.values[raw] || raw;
    else if (key === "resourceType") value = e.resource[raw] || raw;
    else if (key === "role") value = e.roles[raw] || raw;
    else if ((key === "unitTotal" || key === "units") && resource) value = formatAmount(e, resource, raw, locale);
    else if (key === "defaultMemberWeeklyBudget" || key === "weeklyBudget") value = raw === null ? h.values.unlimited : formatAmount(e, "token", raw, locale);
    else if (key === "unitTotal" || key === "units") value = raw === null ? h.values.unlimited : formatNumber(raw, locale);
    else if (typeof raw === "boolean") value = raw ? h.values.yes : h.values.no;
    else if (raw === null) value = h.values.unlimited;
    else if (typeof raw === "object") continue;
    out.push([label, String(value)]);
  }
  return out;
}

export default async function AdminOrgDetailPage({ params, searchParams }) {
  const { id } = await params;
  const query = (await searchParams) || {};
  const { locale, t } = await getI18n();
  const e = t.admin.enterprise;
  const d = e.detail;
  let data;
  try { data = await apiGet(`/api/admin/enterprise/organizations/${encodeURIComponent(id)}`); }
  catch (error) { if (error.status !== 404) throw error; }
  const org = data?.organization;
  if (!org?.id) {
    return (
      <AdminShell title={t.admin.pages.enterprise[0]}>
        <div className="mb-4"><Link href="/admin/enterprise" className="text-sm font-semibold text-brand">← {d.back}</Link></div>
        <AdminEmpty title={d.notFoundTitle} description={d.notFoundDesc} />
      </AdminShell>
    );
  }

  const days = USAGE_DAYS.includes(Number(query.days)) ? Number(query.days) : 30;
  const before = Number.parseInt(String(query.before || ""), 10) || 0;
  const [usageData, auditData] = await Promise.all([
    loadAdmin(`/api/admin/enterprise/organizations/${encodeURIComponent(id)}/usage?days=${days}`, { usage: { byMember: [], byModel: [], totals: { requests: 0, units: 0 } } }),
    loadAdmin(`/api/admin/enterprise/organizations/${encodeURIComponent(id)}/audit?limit=50${before ? `&before=${before}` : ""}`, { entries: [], nextBefore: null }),
  ]);
  const usage = usageData?.usage || {};
  const byMember = Array.isArray(usage.byMember) ? usage.byMember : [];
  const byModel = Array.isArray(usage.byModel) ? usage.byModel : [];
  const totals = usage.totals || { requests: 0, units: 0 };
  const entries = Array.isArray(auditData?.entries) ? auditData.entries : [];
  const nextBefore = auditData?.nextBefore || null;

  const status = orgStatus(org);
  const owners = Array.isArray(org.owners) ? org.owners : [];
  const grants = Array.isArray(org.grants) ? org.grants : [];
  const available = Object.fromEntries(RESOURCES.map((resource) => [resource, grants
    .filter((grant) => grant.resource_type === resource && grant.state === "active")
    .reduce((sum, grant) => sum + Number(grant.unit_remaining || 0), 0)]));
  const budget = org.default_member_weekly_budget;
  const hasBudget = budget !== null && budget !== undefined && budget !== "";
  const orgHref = `/admin/enterprise/${encodeURIComponent(org.id)}`;
  const withQuery = (next, hash) => {
    const merged = { days: days === 30 ? "" : String(days), before: before ? String(before) : "", ...next };
    const qs = new URLSearchParams(Object.entries(merged).filter(([, value]) => value));
    return `${orgHref}${qs.toString() ? `?${qs}` : ""}#${hash}`;
  };

  return (
    <AdminShell title={org.name} subtitle={fill(d.subtitle, { id: org.id, date: formatDate(org.created_at, locale) })}>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <Link href="/admin/enterprise" className="font-semibold text-brand">← {d.back}</Link>
        <nav className="flex flex-wrap gap-3 text-slate-600">
          {["status", "owners", "pool", "usage", "history", "settings"].map((key) => (
            <a key={key} href={`#${key}`} className="hover:text-slate-900 hover:underline">{d.nav[key]}</a>
          ))}
        </nav>
      </div>

      <Section id="status" title={d.statusTitle} aside={<span className="flex items-center gap-2 text-sm text-slate-500">{d.effective}<OrgStatusBadge org={org} copy={e} /></span>}>
        <p className="mb-3 text-sm text-slate-600">{d.layersIntro}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className={`rounded-lg border p-4 ${status.frozen ? "border-red-200 bg-red-50/40" : "border-slate-200"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">{d.platformLayer}</span>
              <Badge variant={status.frozen ? "danger" : "success"}>{status.frozen ? d.layerFrozen : d.layerOn}</Badge>
            </div>
            <p className="mt-1 text-xs text-slate-500">{d.platformLayerHelp}</p>
            {status.frozen ? (
              <p className="mt-2 text-sm text-slate-700">
                {org.platform_status_changed_at ? `${fill(d.frozenSince, { date: formatDate(org.platform_status_changed_at, locale, true) })} · ` : ""}
                {org.platform_status_reason ? fill(d.reason, { reason: org.platform_status_reason }) : d.noReason}
              </p>
            ) : null}
            <div className="mt-4 border-t border-slate-100 pt-4">
              {status.frozen ? (
                <EnterpriseDangerForm action={unfreezeOrganizationAction.bind(null, org.id)} confirm={d.unfreezeConfirm} name={org.name} className="grid gap-2">
                  <p className="text-xs text-slate-500">{d.unfreezeHelp}</p>
                  {status.paused ? <p className="text-xs font-medium text-amber-800">{d.unfreezeStillPaused}</p> : null}
                  <div><button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">{d.unfreeze}</button></div>
                </EnterpriseDangerForm>
              ) : (
                <EnterpriseDangerForm action={freezeOrganizationAction.bind(null, org.id)} confirm={d.freezeConfirm} name={org.name} className="grid gap-2">
                  <p className="text-xs text-slate-500">{d.freezeHelp}</p>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-700">{d.freezeReason}<span className="ms-1 text-red-600" aria-hidden="true">*</span></span>
                    <input name="reason" required maxLength={200} placeholder={d.freezeReasonPlaceholder} className={inputClass} />
                    <span className="mt-1 block text-xs text-slate-500">{d.freezeReasonHelp}</span>
                  </label>
                  <div><button type="submit" className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">{d.freeze}</button></div>
                </EnterpriseDangerForm>
              )}
            </div>
          </div>
          <div className={`rounded-lg border p-4 ${status.paused ? "border-amber-200 bg-amber-50/40" : "border-slate-200"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">{d.ownerLayer}</span>
              <Badge variant={status.paused ? "warning" : "success"}>{status.paused ? d.layerPaused : d.layerOn}</Badge>
            </div>
            <p className="mt-1 text-xs text-slate-500">{d.ownerLayerHelp}</p>
          </div>
        </div>
      </Section>

      <Section id="owners" title={d.ownersTitle} help={d.ownersHelp}>
        {owners.length ? (
          <ul className="divide-y divide-slate-100">
            {owners.map((owner) => (
              <li key={owner.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <Link href={`/admin/users/${encodeURIComponent(owner.id)}`} className="font-semibold text-brand hover:underline">{owner.loginName || d.ownerPhoneAccount}</Link>
                  {owner.displayName ? <span className="text-slate-600"> · {owner.displayName}</span> : null}
                  <span className="ms-2 inline-flex gap-1 align-middle">
                    {owner.issued ? <Badge variant="brand">{d.ownerIssuedBadge}</Badge> : null}
                    <Badge variant={owner.passwordMustChange ? "warning" : "success"}>{owner.passwordMustChange ? d.ownerPending : d.ownerActive}</Badge>
                  </span>
                </div>
                {owner.issued && owner.passwordMustChange ? (
                  <EnterpriseDangerForm action={reissueOwnerInitialPasswordAction.bind(null, org.id, owner.id)} confirm={d.reissueConfirm} name={owner.loginName || owner.id} className="grid justify-items-end gap-2">
                    <button type="submit" className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">{d.reissue}</button>
                  </EnterpriseDangerForm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{d.noOwners}</p>
        )}
        <div className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-600">
          <p className="font-medium text-slate-800">{fill(d.membersLine, { members: formatNumber(org.memberCount, locale), pending: formatNumber(org.pendingInvitations, locale) })}</p>
          <p className="mt-1 text-xs text-slate-500">{d.membersNote}</p>
        </div>
      </Section>

      <Section id="pool" title={e.pool.title} help={e.pool.help}>
        <div className="mb-5 grid gap-3 md:grid-cols-3">
          {RESOURCES.map((resource) => (
            <div key={resource} className="metric-card rounded-xl p-4">
              <div className="text-sm text-slate-500">{e.resource[resource]} · {e.pool.remaining}</div>
              <div className={`mt-1 font-mono text-xl font-semibold ${available[resource] ? "" : "text-slate-400"}`}>
                {available[resource] ? formatAmount(e, resource, available[resource], locale) : e.pool.none}
              </div>
            </div>
          ))}
        </div>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">{e.pool.grantsTitle}</h3>
        {grants.length ? (
          <SimpleTable headers={["resource", "remaining", "state", "starts", "expires", "actions"].map((key) => e.pool.cols[key])}>
            {grants.map((grant) => (
              <tr key={grant.id} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2">{e.resource[grant.resource_type] || grant.resource_type}<div className="font-mono text-xs text-slate-400">{grant.id}</div></td>
                <td className="whitespace-nowrap px-4 py-2 tabular-nums">{formatNumber(grant.unit_remaining, locale)} / {formatNumber(grant.unit_total, locale)}</td>
                <td className="px-4 py-2">
                  <Badge variant={grant.state === "active" ? "success" : grant.state === "revoked" ? "danger" : grant.state === "scheduled" ? "brand" : "default"}>{e.pool.states[grant.state] || grant.state}</Badge>
                </td>
                <td className="whitespace-nowrap px-4 py-2">{formatDate(grant.starts_at, locale)}</td>
                <td className="whitespace-nowrap px-4 py-2">{formatDate(grant.expires_at, locale)}</td>
                <td className="px-4 py-2">
                  {REDUCIBLE.has(grant.state) && Number(grant.unit_remaining || 0) > 0 ? (
                    <GrantRowActions
                      reduceAction={reduceGrantAction.bind(null, org.id, grant.id)}
                      revokeAction={revokeGrantAction.bind(null, org.id, grant.id)}
                      resourceType={grant.resource_type}
                      remaining={Number(grant.unit_remaining || 0)}
                    />
                  ) : <span className="text-slate-400">-</span>}
                </td>
              </tr>
            ))}
          </SimpleTable>
        ) : (
          <AdminEmpty title={e.pool.emptyTitle} description={e.pool.emptyDesc} />
        )}
        <div className="mt-6 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">{e.grant.title}</h3>
          <p className="mb-3 mt-1 text-xs text-slate-500">{e.grant.help}</p>
          {owners.length ? null : <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{d.noOwners}</p>}
          <GrantQuotaForm
            action={grantOrganizationQuotaAction.bind(null, org.id)}
            organizationName={org.name}
            idempotencyKey={globalThis.crypto.randomUUID()}
            disabled={!owners.length}
          />
        </div>
      </Section>

      <Section
        id="usage"
        title={e.usage.title}
        help={e.usage.help}
        aside={(
          <span className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-sm">
            {USAGE_DAYS.map((value) => (
              <Link key={value} href={withQuery({ days: value === 30 ? "" : String(value) }, "usage")} aria-current={value === days ? "true" : undefined}
                className={`border-s border-slate-300 px-3 py-1.5 first:border-s-0 ${value === days ? "bg-slate-900 font-medium text-white" : "text-slate-700 hover:bg-slate-50"}`}>
                {fill(e.usage.days, { n: value })}
              </Link>
            ))}
          </span>
        )}
      >
        <div className="mb-5 grid gap-3 md:grid-cols-2">
          <div className="metric-card rounded-xl p-4"><div className="font-mono text-xl font-semibold">{formatNumber(totals.units, locale)}</div><div className="mt-1 text-sm text-slate-500">{e.usage.totalsUnits}</div></div>
          <div className="metric-card rounded-xl p-4"><div className="font-mono text-xl font-semibold">{formatNumber(totals.requests, locale)}</div><div className="mt-1 text-sm text-slate-500">{e.usage.totalsRequests}</div></div>
        </div>
        {byMember.length || byModel.length ? (
          <div className="grid gap-5 xl:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">{e.usage.byMember}</h3>
              <SimpleTable headers={[e.usage.cols.member, e.usage.cols.units, e.usage.cols.requests, e.usage.cols.tokens]}>
                {byMember.map((row) => (
                  <tr key={row.user_id} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      <Link href={`/admin/users/${encodeURIComponent(row.user_id)}`} className="font-medium text-brand hover:underline">{personLabel(row)}</Link>
                      <div className="text-xs text-slate-500">{[row.loginName, row.phone].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{formatNumber(row.units, locale)}</td>
                    <td className="px-4 py-2 tabular-nums">{formatNumber(row.request_count, locale)}</td>
                    <td className="px-4 py-2 tabular-nums">{formatNumber(row.tokens, locale)}</td>
                  </tr>
                ))}
              </SimpleTable>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">{e.usage.byModel}</h3>
              <SimpleTable headers={[e.usage.cols.model, e.usage.cols.units, e.usage.cols.requests]}>
                {byModel.map((row, index) => (
                  <tr key={row.model || index} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs">{row.model || e.usage.unknownModel}</td>
                    <td className="px-4 py-2 tabular-nums">{formatNumber(row.units, locale)}</td>
                    <td className="px-4 py-2 tabular-nums">{formatNumber(row.request_count, locale)}</td>
                  </tr>
                ))}
              </SimpleTable>
            </div>
          </div>
        ) : (
          <AdminEmpty title={e.usage.emptyTitle} description={e.usage.emptyDesc} />
        )}
      </Section>

      <Section id="history" title={e.history.title} help={e.history.help}>
        {entries.length ? (
          <SimpleTable headers={["time", "actor", "action", "detail"].map((key) => e.history.cols[key])}>
            {entries.map((entry) => {
              const metadata = parseMetadata(entry.metadata);
              const pairs = describeMetadata(metadata, e, locale);
              const actor = entry.actor || {};
              return (
                <tr key={entry.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2">{formatDate(entry.createdAt, locale, true)}</td>
                  <td className="px-4 py-2">
                    {actor.kind === "member" ? (
                      <>
                        <Link href={`/admin/users/${encodeURIComponent(actor.userId)}`} className="font-medium text-brand hover:underline">{personLabel(actor)}</Link>
                        {metadata.role ? <div className="text-xs text-slate-500">{e.roles[metadata.role] || metadata.role}</div> : null}
                      </>
                    ) : (
                      <>
                        <Badge variant="brand">{e.history.platform}</Badge>
                        {actor.name ? <div className="mt-1 text-xs text-slate-500">{actor.name}</div> : null}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2 font-medium">{e.history.actions[entry.action] || entry.action}</td>
                  <td className="px-4 py-2">
                    {pairs.length ? (
                      <ul className="space-y-0.5">{pairs.map(([label, value]) => <li key={label}><span className="text-slate-500">{label}{locale === "zh" ? "：" : ": "}</span>{value}</li>)}</ul>
                    ) : null}
                    {Object.keys(metadata).length ? (
                      <details className="mt-1 text-xs text-slate-500">
                        <summary className="cursor-pointer">{e.history.raw}</summary>
                        <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(metadata, null, 2)}</pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </SimpleTable>
        ) : (
          <AdminEmpty title={e.history.emptyTitle} description={e.history.emptyDesc} />
        )}
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          {before ? <Link href={withQuery({ before: "" }, "history")} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50">{e.history.latest}</Link> : null}
          {nextBefore
            ? <Link href={withQuery({ before: String(nextBefore) }, "history")} className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50">{e.history.more}</Link>
            : entries.length ? <span className="text-slate-400">{e.history.end}</span> : null}
        </div>
      </Section>

      <Section id="settings" title={d.settingsTitle} help={org.plan ? fill(d.planLine, { plan: org.plan }) : ""}>
        <div className="grid gap-6 lg:grid-cols-2">
          <EnterpriseActionForm action={renameOrganizationAction.bind(null, org.id)} className="grid content-start gap-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">{d.renameTitle}</span>
              <input name="name" required maxLength={120} defaultValue={org.name} className={inputClass} />
            </label>
            <div><button type="submit" className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">{d.rename}</button></div>
          </EnterpriseActionForm>
          <EnterpriseActionForm action={setDefaultWeeklyBudgetAction.bind(null, org.id)} className="grid content-start gap-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">{d.budgetTitle}</span>
              <input name="defaultMemberWeeklyBudget" inputMode="numeric" defaultValue={hasBudget ? String(budget) : ""} placeholder={d.budgetPlaceholder} className={`${inputClass} tabular-nums`} />
              <span className="mt-1 block text-xs text-slate-500">{fill(d.budgetCurrent, { value: hasBudget ? formatAmount(e, "token", budget, locale) : d.budgetUnlimited })}</span>
              <span className="mt-1 block text-xs text-slate-500">{d.budgetHelp}</span>
            </label>
            <div><button type="submit" className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">{d.saveBudget}</button></div>
          </EnterpriseActionForm>
        </div>
      </Section>
    </AdminShell>
  );
}
