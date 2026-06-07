import { AdminShell } from "../../../components/admin-shell";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function statusClass(ok, status) {
  if (ok && status !== "warning") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "warning") return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-rose-50 text-rose-700 ring-rose-200";
}

function checkClass(ok, unsigned) {
  if (ok && !unsigned) return "border-emerald-200 bg-emerald-50/50";
  if (ok && unsigned) return "border-amber-200 bg-amber-50/50";
  return "border-rose-200 bg-rose-50/50";
}

export default async function HealthPage() {
  const { t } = await getI18n();
  const health = await safeApiGet("/api/admin/health", {
    ok: false,
    status: "error",
    checkedAt: "",
    runtime: {},
    checks: [],
  });
  const labels = t.admin.health;
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const runtime = health.runtime || {};

  return (
    <AdminShell title={t.admin.pages.health[0]} subtitle={t.admin.pages.health[1]}>
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold uppercase tracking-wide text-slate-400">{labels.overall}</div>
            <div className="mt-2 text-2xl font-semibold text-slate-950">{labels.status[health.status] || health.status}</div>
            {health.checkedAt ? <div className="mt-1 text-sm text-slate-500">{labels.checkedAt}: {new Date(health.checkedAt).toLocaleString()}</div> : null}
          </div>
          <span className={`inline-flex w-fit rounded-full px-4 py-2 text-sm font-semibold ring-1 ${statusClass(health.ok, health.status)}`}>
            {health.ok ? labels.ready : labels.needsAttention}
          </span>
        </div>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <div key={check.name} className={`rounded-xl border p-5 ${checkClass(check.ok, check.unsigned)}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-950">{labels.checks[check.name] || check.name}</div>
                <div className="mt-2 text-sm text-slate-600">{check.detail || "-"}</div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${check.ok ? "bg-white text-emerald-700" : "bg-white text-rose-700"}`}>
                {check.ok ? labels.ok : labels.failed}
              </span>
            </div>
            {check.url ? <div className="mt-3 break-all text-xs text-slate-400">{check.url}</div> : null}
          </div>
        ))}
      </section>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">{labels.runtime}</h2>
        <dl className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[
            ["nodeEnv", runtime.nodeEnv],
            ["imageTag", runtime.imageTag],
            ["packageVersion", runtime.packageVersion],
            ["qiniuPublicBaseUrl", runtime.qiniuPublicBaseUrl],
            ["allowUnsignedLicenses", String(Boolean(runtime.allowUnsignedLicenses))],
            ["modelGatewayEnabled", String(Boolean(runtime.modelGatewayEnabled))],
            ["modelGatewayDefaultProvider", runtime.modelGatewayDefaultProvider],
            ["modelGatewayTokenTtlSeconds", runtime.modelGatewayTokenTtlSeconds],
          ].map(([key, value]) => (
            <div key={key} className="rounded-lg bg-slate-50 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{labels.runtimeFields[key] || key}</dt>
              <dd className="mt-2 break-all font-mono text-sm text-slate-800">{value || "-"}</dd>
            </div>
          ))}
        </dl>
      </section>
    </AdminShell>
  );
}
