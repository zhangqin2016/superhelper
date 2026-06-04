import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { Badge } from "../../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { safeApiGet } from "../../../../lib/api";

export const dynamic = "force-dynamic";

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

export default async function DeviceDetailPage({ params }) {
  const { id } = await params;
  const data = await safeApiGet(`/api/admin/devices/${id}`, null);
  if (!data?.device) {
    return (
      <AdminShell title="Device not found" subtitle={id}>
        <AdminEmpty title="No matching device" description="The device may not have registered yet or the API is unavailable." />
      </AdminShell>
    );
  }

  const { device, licenses = [], usage = [] } = data;
  const tokens = sum(usage, "input_tokens") + sum(usage, "output_tokens");

  return (
    <AdminShell title={device.id} subtitle={`${device.platform || "-"} / ${device.arch || "-"} · ${device.app_version || "-"}`}>
      <div className="mb-5">
        <Link href="/admin/devices" className="text-sm font-semibold text-brand">Back to devices</Link>
      </div>
      <div className="mb-6 grid gap-5 lg:grid-cols-4">
        {[
          ["Messages", fmt(sum(usage, "message_count"))],
          ["Images", fmt(sum(usage, "image_count"))],
          ["Tool calls", fmt(sum(usage, "tool_call_count"))],
          ["Tokens", fmt(tokens)],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader><CardTitle>{label}</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-semibold">{value}</div></CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
        <Card>
          <CardHeader><CardTitle>Device profile</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <div className="flex justify-between gap-4"><span>First seen</span><b>{device.first_seen_at ? new Date(device.first_seen_at).toLocaleString() : "-"}</b></div>
            <div className="flex justify-between gap-4"><span>Last seen</span><b>{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "-"}</b></div>
            <div className="flex justify-between gap-4"><span>Trial ends</span><b>{device.trial_ends_at ? new Date(device.trial_ends_at).toLocaleString() : "-"}</b></div>
            <div className="break-all border-t border-slate-100 pt-3 font-mono text-xs">{device.fingerprint_hash || "no fingerprint hash"}</div>
          </CardContent>
        </Card>
        <div className="table-card p-6">
          <h2 className="mb-5 text-xl font-semibold">License bindings</h2>
          {licenses.length ? (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>{["License", "Customer", "Plan", "Status", "Last seen"].map((h) => <th key={h} className="px-5 py-4">{h}</th>)}</tr>
              </thead>
              <tbody>{licenses.map((license) => (
                <tr key={license.id} className="border-t border-slate-100">
                  <td className="px-5 py-4"><Link href={`/admin/licenses/${license.license_id}`} className="font-mono text-brand">{license.license_id}</Link></td>
                  <td className="px-5 py-4">{license.customer_name || "-"}</td>
                  <td className="px-5 py-4">{license.plan || "-"}</td>
                  <td className="px-5 py-4"><Badge variant={license.status === "active" ? "success" : "danger"}>{license.status}</Badge></td>
                  <td className="px-5 py-4">{license.last_seen_at ? new Date(license.last_seen_at).toLocaleString() : "-"}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <AdminEmpty title="No license bindings" description="This device has not activated a license yet." />}
        </div>
      </div>
      <div className="table-card mt-6 p-6">
        <h2 className="mb-5 text-xl font-semibold">Recent usage</h2>
        {usage.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>{["Date", "Model", "Messages", "Images", "Tools", "Tokens"].map((h) => <th key={h} className="px-5 py-4">{h}</th>)}</tr>
            </thead>
            <tbody>{usage.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-5 py-4">{String(row.usage_date).slice(0, 10)}</td>
                <td className="px-5 py-4">{row.model}</td>
                <td className="px-5 py-4">{fmt(row.message_count)}</td>
                <td className="px-5 py-4">{fmt(row.image_count)}</td>
                <td className="px-5 py-4">{fmt(row.tool_call_count)}</td>
                <td className="px-5 py-4">{fmt(Number(row.input_tokens || 0) + Number(row.output_tokens || 0))}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <AdminEmpty title="No usage yet" description="Usage appears after the client reports aggregated counts." />}
      </div>
    </AdminShell>
  );
}
