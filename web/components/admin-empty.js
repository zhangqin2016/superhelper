// Presentational only: it carries no language of its own, so every caller
// supplies translated copy (the shared table supplies the default one).
export function AdminEmpty({ title = "", description = "" }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
      <div className="font-semibold text-slate-950">{title}</div>
      <div className="mt-2 text-sm text-slate-500">{description}</div>
    </div>
  );
}
