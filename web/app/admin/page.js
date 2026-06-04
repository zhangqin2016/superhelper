import { AdminShell } from "../../components/admin-shell";
import { AdminDashboardCharts } from "../../components/admin-dashboard-charts";
import { safeApiGet } from "../../lib/api";
import { getI18n } from "../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export default async function AdminDashboard() {
  const { t } = await getI18n();
  const summary = await safeApiGet("/api/admin/summary", {
    licenses: 0,
    activeLicenses: 0,
    devices: 0,
    activeDevicesToday: 0,
    todayMessages: 0,
    todayTokens: 0,
    models: [],
    trend: [],
  });
  const cards = [
    [t.admin.cards.licenses, fmt(summary.licenses), `${fmt(summary.activeLicenses)} ${t.admin.cards.active}`],
    [t.admin.cards.devices, fmt(summary.devices), t.admin.cards.registered],
    [t.admin.cards.activeToday, fmt(summary.activeDevicesToday), t.admin.cards.reporting],
    [t.admin.cards.messagesToday, fmt(summary.todayMessages), t.admin.cards.aggregated],
  ];
  const models = summary.models?.length ? summary.models : [[t.admin.charts.noModel, 0]].map(([model, messages]) => ({ model, messages }));
  const trend = summary.trend?.length ? summary.trend : [{ date: t.admin.charts.noUsage, messages: 0, activeDevices: 0 }];

  return (
    <AdminShell title={t.admin.dashboardTitle} subtitle={t.admin.dashboardSubtitle}>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value, desc]) => (
          <div key={label} className="metric-card rounded-xl p-5">
            <div className="font-mono text-3xl font-semibold">{value}</div>
            <div className="mt-2 font-semibold">{label}</div>
            <div className="mt-1 text-sm text-slate-500">{desc}</div>
          </div>
        ))}
      </div>
      <AdminDashboardCharts trend={trend} models={models} todayTokens={summary.todayTokens} labels={t.admin.charts} />
    </AdminShell>
  );
}
