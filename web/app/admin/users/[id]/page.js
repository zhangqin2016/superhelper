import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function fmt(value, locale = "zh") {
  return Number(value || 0).toLocaleString(locale === "zh" ? "zh-CN" : locale);
}

function money(cents, currency = "CNY") {
  return `${currency === "CNY" ? "¥" : currency} ${(Number(cents || 0) / 100).toFixed(2)}`;
}

function date(value, locale = "zh") {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString(locale === "zh" ? "zh-CN" : locale);
}

function Section({ title, children }) {
  return (
    <section className="table-card p-6">
      <h2 className="mb-5 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SimpleTable({ headers, rows, emptyTitle, emptyDesc }) {
  if (!rows.length) return <AdminEmpty title={emptyTitle} description={emptyDesc} />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>{headers.map((header) => <th key={header} className="px-5 py-4">{header}</th>)}</tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

export default async function AdminUserDetailPage({ params }) {
  const { locale, t } = await getI18n();
  const c = t.admin.usersView;
  const { id } = await params;
  const data = await safeApiGet(`/api/admin/users/${encodeURIComponent(id)}`, null);
  if (!data?.user) notFound();

  const {
    user,
    entitlements = {},
    orders = [],
    grants = [],
    ledger = [],
    sessions = [],
    devices = [],
    smsCodes = [],
    usageEvents = [],
  } = data;

  return (
    <AdminShell title={c.detailTitle.replace("{phone}", user.phoneE164)} subtitle={`${user.id} · ${user.status}`}>
      <div className="mb-5">
        <Link href="/admin/users" className="text-sm font-semibold text-brand">{c.back}</Link>
      </div>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">
        {[
          [c.metrics[0], fmt(entitlements.tokenBalance, locale)],
          [c.metrics[1], fmt(entitlements.imageGenerationsRemaining, locale)],
          [c.metrics[2], fmt(entitlements.videoGenerationsRemaining, locale)],
          [c.metrics[3], entitlements.membershipExpiresAt ? date(entitlements.membershipExpiresAt, locale) : c.inactive],
          [c.metrics[4], entitlements.freeGrantExpiresAt ? date(entitlements.freeGrantExpiresAt, locale) : "-"],
        ].map(([label, value]) => (
          <div key={label} className="metric-card rounded-xl p-5">
            <div className="font-mono text-xl font-semibold">{value}</div>
            <div className="mt-2 text-sm text-slate-500">{label}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Section title={c.sections.orders}>
          <SimpleTable
            headers={c.headers.orders}
            emptyTitle={c.empty.orders[0]}
            emptyDesc={c.empty.orders[1]}
            rows={orders.map((order) => (
              <tr key={order.id} className="border-t border-slate-100">
                <td className="px-5 py-4">{date(order.created_at, locale)}</td>
                <td className="px-5 py-4">
                  <div className="font-medium">{order.product_name || order.product_id}</div>
                  <div className="font-mono text-xs text-slate-400">{order.id}</div>
                </td>
                <td className="px-5 py-4">{money(order.amount_cents, order.currency)}</td>
                <td className="px-5 py-4">{order.provider}</td>
                <td className="px-5 py-4">{order.status}{order.paid_at ? ` · ${date(order.paid_at, locale)}` : ""}</td>
              </tr>
            ))}
          />
        </Section>

        <Section title={c.sections.devices}>
          <SimpleTable
            headers={c.headers.devices}
            emptyTitle={c.empty.devices[0]}
            emptyDesc={c.empty.devices[1]}
            rows={devices.map((device) => (
              <tr key={device.device_id} className="border-t border-slate-100">
                <td className="px-5 py-4 font-mono text-xs">
                  <Link href={`/admin/devices/${device.device_id}`} className="text-brand hover:underline">{device.device_id}</Link>
                </td>
                <td className="px-5 py-4">{[device.platform, device.arch, device.app_version].filter(Boolean).join(" / ") || "-"}</td>
                <td className="px-5 py-4">{device.status}</td>
                <td className="px-5 py-4">{date(device.last_seen_at, locale)}</td>
              </tr>
            ))}
          />
        </Section>

        <Section title={c.sections.grants}>
          <SimpleTable
            headers={c.headers.grants}
            emptyTitle={c.empty.grants[0]}
            emptyDesc={c.empty.grants[1]}
            rows={grants.map((grant) => (
              <tr key={grant.id} className="border-t border-slate-100">
                <td className="px-5 py-4">{grant.source_type}<div className="font-mono text-xs text-slate-400">{grant.source_id || grant.id}</div></td>
                <td className="px-5 py-4">{grant.resource_type}</td>
                <td className="px-5 py-4">{grant.resource_type === "token" ? `${fmt(grant.token_remaining, locale)} / ${fmt(grant.token_total, locale)}` : `${fmt(grant.unit_remaining, locale)} / ${fmt(grant.unit_total, locale)}`}</td>
                <td className="px-5 py-4">{grant.status}</td>
                <td className="px-5 py-4">{date(grant.expires_at, locale)}</td>
              </tr>
            ))}
          />
        </Section>

        <Section title={c.sections.ledger}>
          <SimpleTable
            headers={c.headers.ledger}
            emptyTitle={c.empty.ledger[0]}
            emptyDesc={c.empty.ledger[1]}
            rows={ledger.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-5 py-4">{date(row.created_at, locale)}</td>
                <td className="px-5 py-4">{row.event_type}</td>
                <td className="px-5 py-4">{row.resource_type || "-"}</td>
                <td className="px-5 py-4">{row.resource_type === "token" ? fmt(row.token_delta, locale) : fmt(row.unit_delta, locale)}</td>
                <td className="px-5 py-4">{row.source_type || "-"} {row.source_id || ""}</td>
              </tr>
            ))}
          />
        </Section>

        <Section title={c.sections.sms}>
          <SimpleTable
            headers={c.headers.sms}
            emptyTitle={c.empty.sms[0]}
            emptyDesc={c.empty.sms[1]}
            rows={smsCodes.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-5 py-4">{date(row.created_at, locale)}</td>
                <td className="px-5 py-4 font-mono text-xs">{row.device_id || "-"}</td>
                <td className="px-5 py-4">{row.send_status}</td>
                <td className="px-5 py-4">{fmt(row.attempt_count, locale)}</td>
                <td className="px-5 py-4">{row.risk_level}{row.risk_reason ? ` · ${row.risk_reason}` : ""}</td>
                <td className="px-5 py-4">{row.ip || "-"}</td>
              </tr>
            ))}
          />
        </Section>

        <Section title={c.sections.usage}>
          <SimpleTable
            headers={c.headers.usage}
            emptyTitle={c.empty.usage[0]}
            emptyDesc={c.empty.usage[1]}
            rows={usageEvents.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-5 py-4">{date(row.created_at, locale)}</td>
                <td className="px-5 py-4">{row.feature || "-"}</td>
                <td className="px-5 py-4">{row.model || row.provider || "-"}</td>
                <td className="px-5 py-4">{row.resource_type === "token" ? fmt(row.billable_tokens, locale) : fmt(row.billable_units, locale)}</td>
                <td className="px-5 py-4">{row.status}</td>
              </tr>
            ))}
          />
        </Section>
      </div>
    </AdminShell>
  );
}
