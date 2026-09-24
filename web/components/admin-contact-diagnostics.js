import { Download } from "lucide-react";

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS_TONE = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  error: "border-rose-200 bg-rose-50 text-rose-700",
};

// What the desktop client attached: the diagnostics report's non-ok checks,
// and the log behind an admin-only download (never a public URL).
export function AdminContactDiagnostics({ contactId, diagnostics, copy }) {
  if (!diagnostics) return null;
  const report = diagnostics.report || null;
  const status = report?.summary?.status || "";
  const issues = (report?.checks || []).filter((check) => check?.status && check.status !== "ok");
  const context = report?.context || {};
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-slate-700">{copy.diagnosticsLabel}</span>
        {status ? (
          <span className={`rounded-full border px-2 py-0.5 ${STATUS_TONE[status] || STATUS_TONE.warning}`}>
            {status === "ok" ? copy.diagnosticsOk : copy.diagnosticsIssues.replace("{count}", String(issues.length))}
          </span>
        ) : null}
        {context.appVersion ? <span className="text-slate-400">v{context.appVersion} · {context.platform}/{context.arch}</span> : null}
      </div>
      {issues.length ? (
        <ul className="space-y-1">
          {issues.slice(0, 8).map((check) => (
            <li key={check.id} className="leading-5">
              <span className={check.status === "error" ? "text-rose-600" : "text-amber-600"}>●</span>{" "}
              <span className="font-medium text-slate-700">{check.label || check.id}</span>
              {check.detail ? <span className="text-slate-500">：{check.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {report ? (
        <details>
          <summary className="cursor-pointer text-slate-500">{copy.diagnosticsRaw}</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white p-2 text-[11px] leading-4 text-slate-600">{JSON.stringify(report, null, 2)}</pre>
        </details>
      ) : null}
      {diagnostics.hasLog ? (
        <a
          href={`/admin/contacts/${encodeURIComponent(contactId)}/log`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:border-teal-300 hover:text-teal-700"
        >
          <Download className="h-3.5 w-3.5" />
          {copy.downloadLog} {formatSize(diagnostics.logBytes)}
          {diagnostics.logTruncated ? <span className="text-slate-400">· {copy.logTruncated}</span> : null}
        </a>
      ) : (
        <div className="text-slate-400">{copy.noLog}</div>
      )}
    </div>
  );
}
