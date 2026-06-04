import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { LicenseEditForm } from "../../../../components/license-edit-form";
import { Badge } from "../../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { safeApiGet } from "../../../../lib/api";

export const dynamic = "force-dynamic";

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function featureText(features) {
  if (Array.isArray(features)) return features.join(", ");
  if (typeof features === "string") {
    try {
      const parsed = JSON.parse(features);
      if (Array.isArray(parsed)) return parsed.join(", ");
    } catch {
      return features;
    }
  }
  return "-";
}

export default async function LicenseDetailPage({ params }) {
  const { id } = await params;
  const data = await safeApiGet(`/api/admin/licenses/${id}`, null);
  if (!data?.license) {
    return (
      <AdminShell title="License not found" subtitle={id}>
        <AdminEmpty title="No matching license" description="The license may have been removed or the API is unavailable." />
      </AdminShell>
    );
  }

  const { license, devices = [], usage = {} } = data;
  const tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);

  return (
    <AdminShell title={license.id} subtitle={`${license.customer_name || "Unnamed customer"} · ${license.plan}`}>
      <div className="mb-5">
        <Link href="/admin/licenses" className="text-sm font-semibold text-brand">Back to licenses</Link>
      </div>
      <div className="mb-6 grid gap-5 lg:grid-cols-4">
        {[
          ["Status", <Badge key="status" variant={license.status === "active" ? "success" : "danger"}>{license.status}</Badge>],
          ["Seats", fmt(license.seats)],
          ["Devices", fmt(devices.length)],
          ["Tokens", fmt(tokens)],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader><CardTitle>{label}</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-semibold">{value}</div></CardContent>
          </Card>
        ))}
      </div>
      <LicenseEditForm license={license} />
      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="table-card p-6">
          <h2 className="mb-5 text-xl font-semibold">Bound devices</h2>
          {devices.length ? (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>{["Device", "Platform", "Version", "Status", "Last seen"].map((h) => <th key={h} className="px-5 py-4">{h}</th>)}</tr>
              </thead>
              <tbody>{devices.map((device) => (
                <tr key={device.id} className="border-t border-slate-100">
                  <td className="px-5 py-4 font-mono">{device.device_id}</td>
                  <td className="px-5 py-4">{[device.platform, device.arch].filter(Boolean).join(" / ") || "-"}</td>
                  <td className="px-5 py-4">{device.app_version || "-"}</td>
                  <td className="px-5 py-4">{device.status}</td>
                  <td className="px-5 py-4">{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "-"}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <AdminEmpty title="No devices" description="Devices appear after this license is activated." />}
        </div>
        <Card>
          <CardHeader><CardTitle>Usage summary</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <div className="flex justify-between"><span>Messages</span><b>{fmt(usage.messages)}</b></div>
            <div className="flex justify-between"><span>Images</span><b>{fmt(usage.images)}</b></div>
            <div className="flex justify-between"><span>Tool calls</span><b>{fmt(usage.tool_calls)}</b></div>
            <div className="flex justify-between"><span>Plugin calls</span><b>{fmt(usage.plugin_calls)}</b></div>
            <div className="border-t border-slate-100 pt-3 text-slate-500">Features: {featureText(license.features)}</div>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
