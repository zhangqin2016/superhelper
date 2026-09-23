import Link from "next/link";

/**
 * The dashboard's opening screen: what needs a human, then the shape of the
 * fleet. Replaces four cumulative counters, one of which ("devices: 1,210")
 * was 85% installs nobody had opened in a month.
 */

const nf = (value) => Number(value || 0).toLocaleString("en-US");
const pct = (value) => `${Math.round(Number(value || 0) * 100)}%`;

const TONE = {
  danger: "border-red-200 bg-red-50 text-red-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-slate-200 bg-white text-slate-800",
};

function Section({ title, hint, children }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
        {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Bar({ label, value, share, mark }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className={`truncate font-mono ${mark ? "font-semibold text-emerald-700" : "text-slate-700"}`}>{label}</span>
        <span className="shrink-0 tabular-nums text-slate-500">{value}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-100">
        <div className={`h-1.5 rounded-full ${mark ? "bg-emerald-500" : "bg-brand"}`} style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }} />
      </div>
    </div>
  );
}

export function AdminAttentionPanel({ attention, copy }) {
  if (!attention) return null;
  const { items, fleet, versions, failures, releases } = attention;
  const latest = releases.map((row) => row.latest);
  return (
    <div className="grid gap-4">
      <Section title={copy.needsAttention} hint={items.length ? "" : copy.allClear}>
        {items.length ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <Link key={item.kind} href={item.href} className={`rounded-lg border px-3 py-2 transition hover:shadow-sm ${TONE[item.severity] || TONE.info}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{copy.items[item.kind] || item.kind}</span>
                  <span className="text-lg font-semibold tabular-nums">{nf(item.count)}</span>
                </div>
                {item.detail ? <div className="mt-0.5 truncate font-mono text-xs opacity-80">{item.detail}</div> : null}
              </Link>
            ))}
          </div>
        ) : <p className="text-sm text-slate-500">{copy.allClear}</p>}
      </Section>

      <div className="grid gap-4 xl:grid-cols-3">
        <Section title={copy.fleet} hint={copy.installed.replace("{n}", nf(fleet.installed))}>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[["1d", fleet.active1d], ["7d", fleet.active7d], ["30d", fleet.active30d]].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-slate-50 py-2">
                <div className="text-xl font-semibold tabular-nums text-slate-950">{nf(value)}</div>
                <div className="text-xs text-slate-500">{copy.activeWithin.replace("{w}", label)}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {copy.staleShare.replace("{share}", pct(fleet.installed ? 1 - fleet.active30d / fleet.installed : 0))}
          </p>
        </Section>

        <Section title={copy.versions} hint={copy.versionsHint}>
          <div className="space-y-2">
            {versions.length ? versions.map((row) => (
              <Bar key={row.version} label={row.version} value={`${nf(row.devices)} · ${pct(row.share)}`} share={row.share} mark={latest.includes(row.version)} />
            )) : <p className="text-sm text-slate-500">{copy.noData}</p>}
          </div>
        </Section>

        <Section title={copy.failures} hint={copy.failuresHint.replace("{d1}", nf(failures.last1d)).replace("{d7}", nf(failures.last7d))}>
          <div className="space-y-2">
            {failures.topKinds.length ? failures.topKinds.map((row) => (
              <Bar key={row.kind} label={row.kind} value={nf(row.count)} share={failures.topKinds[0]?.count ? row.count / failures.topKinds[0].count : 0} />
            )) : <p className="text-sm text-slate-500">{copy.noFailures}</p>}
          </div>
          <Link href="/admin/diagnostics" className="mt-3 inline-block text-xs font-medium text-brand hover:underline">{copy.openDiagnostics}</Link>
        </Section>
      </div>

      <Section title={copy.latestReleases}>
        <div className="flex flex-wrap gap-2 text-xs">
          {releases.map((row) => (
            <span key={row.platform} className="rounded-lg bg-slate-100 px-3 py-1.5">
              <span className="font-mono text-slate-700">{row.platform}</span>
              <span className="ms-2 font-semibold text-slate-950">{row.latest}</span>
              <span className="ms-2 text-slate-500">{copy.history.replace("{n}", nf(row.records))}</span>
            </span>
          ))}
        </div>
      </Section>
    </div>
  );
}
