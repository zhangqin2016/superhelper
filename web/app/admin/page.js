import Link from "next/link";
import { AdminShell } from "../../components/admin-shell";
import { AdminAttentionPanel } from "../../components/admin-attention-panel";
import { loadAdmin } from "../../lib/api";
import { getI18n } from "../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

/**
 * The dashboard opens with what needs a human and the shape of the fleet.
 *
 * It used to open with four cumulative counters — licenses, devices, devices
 * active today, messages today — which say how much exists and nothing about
 * what to do. Measured on production the devices counter was 85% installs not
 * seen in a month. Token spend has its own page, which reports its shape.
 */
export default async function AdminDashboard() {
  const { t } = await getI18n();
  const data = await loadAdmin("/api/admin/attention", { attention: null });
  return (
    <AdminShell title={t.admin.dashboardTitle} subtitle={t.admin.dashboardSubtitle}>
      <AdminAttentionPanel attention={data.attention} copy={t.admin.attention} />
      <p className="mt-4 text-xs text-slate-500">
        <Link href="/admin/usage" className="font-medium text-brand hover:underline">{t.admin.usageAnalytics.title} →</Link>
      </p>
    </AdminShell>
  );
}
