import { AdminEmpty } from "./admin-empty";

/**
 * What the token spend looks like, not just how much of it there is.
 *
 * The usage page was a flat dump of daily rows plus a few sums. A sum cannot
 * tell you that one device is a quarter of the whole month, which is what the
 * production data says. This shows the shape: the spread, who carries it, and
 * how much of the window actually carries token data.
 */

const nf = (value) => Number(value || 0).toLocaleString("en-US");
const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-950">{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

function Bars({ title, rows, copy }) {
  const top = rows[0]?.tokens || 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm font-semibold text-slate-950">{title}</div>
      <div className="mt-3 space-y-2">
        {rows.length ? rows.slice(0, 8).map((row) => (
          <div key={row.key}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate font-mono text-slate-700">{row.key}</span>
              <span className="shrink-0 tabular-nums text-slate-500">{nf(row.tokens)} · {pct(row.share)}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-slate-100">
              <div className="h-1.5 rounded-full bg-brand" style={{ width: top ? `${Math.max(2, (row.tokens / top) * 100)}%` : "0%" }} />
            </div>
          </div>
        )) : <p className="text-sm text-slate-500">{copy.noData}</p>}
      </div>
    </div>
  );
}

export function UsageAnalyticsPanel({ analytics, copy }) {
  if (!analytics) return <AdminEmpty title={copy.title} description={copy.unavailable} />;
  const { tokens, coverage, concentration, features, window } = analytics;
  const spread = tokens.p50 ? (tokens.p99 / tokens.p50).toFixed(0) : "-";
  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-950">{copy.title}</h2>
        <p className="text-xs text-slate-500">
          {copy.windowLabel.replace("{days}", String(window.days))} · {copy.grain}
        </p>
      </div>

      {/* Coverage first: the reader learns what the numbers are computed from
          before reading one. */}
      <p className="mt-2 text-xs text-slate-500">
        {copy.coverage
          .replace("{rows}", nf(coverage.rows))
          .replace("{withTokens}", nf(coverage.rowsWithTokens))
          .replace("{share}", pct(coverage.tokenRowShare))}
        {coverage.perTurnAvailable ? "" : ` ${copy.perTurnPending}`}
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={copy.total} value={nf(tokens.total)} hint={`${copy.input} ${nf(tokens.input)} · ${copy.output} ${nf(tokens.output)}`} />
        <Stat label={copy.median} value={nf(tokens.p50)} hint={copy.medianHint} />
        <Stat label="p90 / p99" value={`${nf(tokens.p90)} / ${nf(tokens.p99)}`} hint={copy.spread.replace("{x}", spread)} />
        <Stat label={copy.max} value={nf(tokens.max)} hint={copy.maxHint} />
      </div>

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        {copy.concentration
          .replace("{one}", pct(concentration.top1DeviceShare))
          .replace("{five}", pct(concentration.top5DeviceShare))}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Bars title={copy.byModel} rows={concentration.byModel} copy={copy} />
        <Bars title={copy.byDevice} rows={concentration.byDevice} copy={copy} />
        <Bars title={copy.byLicense} rows={concentration.byLicense} copy={copy} />
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-950">{copy.byFeature}</div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
          {features.length ? features.map((row) => (
            <span key={row.feature} className="rounded-lg bg-slate-100 px-3 py-1.5">
              {row.feature}: {nf(row.events)}
              {row.eventsWithTokens === 0 ? <span className="ms-1 text-amber-700">({copy.noTokenDetail})</span> : null}
            </span>
          )) : <span>{copy.noData}</span>}
        </div>
      </div>
    </section>
  );
}
