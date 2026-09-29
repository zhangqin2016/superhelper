import Link from "next/link";
import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { ListFilter } from "../../../components/list-filter";
import { Pagination } from "../../../components/pagination";
import { Badge } from "../../../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { CreateOrganizationForm } from "../../../components/admin-enterprise-create-form";
import { OrgStatusBadge, fill, formatAmount, formatDate, formatNumber, orgStatus, personLabel } from "../../../components/admin-enterprise-shared";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";
import { createOrganizationAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const STATUSES = ["all", "active", "suspended", "paused"];
const SOURCES = ["all", "platform", "self_serve"];
const RESOURCES = ["token", "image_generation", "video_generation"];

function pick(value, allowed) {
  return allowed.includes(value) ? value : "all";
}

export default async function AdminEnterprisePage({ searchParams }) {
  const { locale, t } = await getI18n();
  const e = t.admin.enterprise;
  const c = e.list;
  const params = (await searchParams) || {};
  const q = String(params.q || "").trim().slice(0, 80);
  const status = pick(String(params.status || "all"), STATUSES);
  const source = pick(String(params.source || "all"), SOURCES);
  const offset = Math.max(0, Number.parseInt(String(params.cursor || "0"), 10) || 0);
  const query = new URLSearchParams({ status, source, limit: String(PAGE_SIZE), offset: String(offset) });
  if (q) query.set("q", q);
  const data = await loadAdmin(`/api/admin/enterprise/organizations?${query}`, { organizations: [], total: 0 });
  const orgs = Array.isArray(data?.organizations) ? data.organizations : [];
  const total = Number(data?.total ?? orgs.length) || 0;
  const filtered = Boolean(q) || status !== "all" || source !== "all";
  const nextCursor = offset + orgs.length < total && orgs.length > 0 ? String(offset + orgs.length) : "";
  const current = { q, status, source, cursor: offset ? String(offset) : "" };

  return (
    <AdminShell title={t.admin.pages.enterprise[0]} subtitle={t.admin.pages.enterprise[1]}>
      <details className="table-card mb-4 p-5" open={!filtered && total === 0}>
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">+ {c.createTitle}</summary>
        <p className="mb-4 mt-2 text-xs text-slate-500">{c.createDesc}</p>
        <CreateOrganizationForm action={createOrganizationAction} />
      </details>

      <form action="/admin/enterprise" className="table-card mb-3 grid gap-2 px-5 py-3">
        <label htmlFor="enterprise-search" className="text-sm font-medium text-slate-700">{c.searchLabel}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="enterprise-search"
            name="q"
            defaultValue={q}
            maxLength={80}
            placeholder={c.searchPlaceholder}
            className="min-w-[16rem] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
          {source !== "all" ? <input type="hidden" name="source" value={source} /> : null}
          <button type="submit" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">{c.search}</button>
          {filtered ? <Link href="/admin/enterprise" className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">{c.clearSearch}</Link> : null}
        </div>
        <span className="text-xs text-slate-500">{c.searchHelp}</span>
      </form>

      <div className="flex flex-wrap items-start gap-x-6">
        <ListFilter basePath="/admin/enterprise" searchParams={current} param="status" value={status} label={c.statusFilter}
          options={STATUSES.map((value) => ({ value, label: c.statusOptions[value] }))} />
        <ListFilter basePath="/admin/enterprise" searchParams={current} param="source" value={source} label={c.sourceFilter}
          options={SOURCES.map((value) => ({ value, label: c.sourceOptions[value] }))} />
        <span className="mb-3 ms-auto self-center text-sm text-slate-500">{fill(c.total, { n: formatNumber(total, locale) })}</span>
      </div>

      <div className="table-card p-4">
        {orgs.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-t-0">
                  {["name", "owner", "status", "members", "pool", "usage30d", "source", "created"].map((key) => <TableHead key={key}>{c.cols[key]}</TableHead>)}
                  <TableHead className="text-end">{c.cols.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.map((org) => {
                  const state = orgStatus(org);
                  const pool = RESOURCES.filter((resource) => Number(org.pool?.[resource] || 0) > 0);
                  const href = `/admin/enterprise/${encodeURIComponent(org.id)}`;
                  return (
                    <TableRow key={org.id}>
                      <TableCell>
                        <Link href={href} className="font-semibold text-brand hover:underline">{org.name}</Link>
                        <div className="font-mono text-xs text-slate-400">{org.id}</div>
                      </TableCell>
                      <TableCell>
                        {org.owner ? (
                          <>
                            <div>{personLabel(org.owner)}</div>
                            <div className="text-xs text-slate-500">{[org.owner.loginName, org.owner.phone].filter((part) => part && part !== personLabel(org.owner)).join(" · ")}</div>
                          </>
                        ) : <span className="text-amber-700">{c.noOwner}</span>}
                      </TableCell>
                      <TableCell>
                        <OrgStatusBadge org={org} copy={e} />
                        {state.frozen ? <div className="mt-1 max-w-[16rem] text-xs text-slate-500">{e.statusWhy.frozen}{org.platform_status_reason ? ` ${fill(e.detail.reason, { reason: org.platform_status_reason })}` : ""}</div> : null}
                        {state.paused ? <div className="mt-1 max-w-[16rem] text-xs text-slate-500">{e.statusWhy.paused}</div> : null}
                      </TableCell>
                      <TableCell className="tabular-nums">{formatNumber(org.member_count, locale)}</TableCell>
                      <TableCell className="tabular-nums">
                        {pool.length
                          ? pool.map((resource) => <div key={resource} className="whitespace-nowrap">{formatAmount(e, resource, org.pool[resource], locale)}</div>)
                          : <span className="text-amber-700">{c.poolEmpty}</span>}
                      </TableCell>
                      <TableCell className="tabular-nums">{formatNumber(org.units30d, locale)}</TableCell>
                      <TableCell>
                        <Badge variant={org.source === "self_serve" ? "warning" : "default"}>{e.source[org.source] || org.source || "-"}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(org.created_at, locale)}</TableCell>
                      <TableCell className="whitespace-nowrap text-end">
                        <Link href={href} className="inline-block whitespace-nowrap rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">{c.open}</Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : filtered ? (
          <AdminEmpty title={c.noMatchTitle} description={c.noMatchDesc} />
        ) : (
          <AdminEmpty title={c.emptyTitle} description={c.emptyDesc} />
        )}
        <Pagination
          basePath="/admin/enterprise"
          searchParams={current}
          shown={offset + orgs.length}
          total={total}
          nextCursor={nextCursor}
          cursor={offset ? String(offset) : ""}
          copy={t.admin.paging}
        />
      </div>
    </AdminShell>
  );
}
