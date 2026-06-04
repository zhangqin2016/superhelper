export function AdminEmpty({ title = "No data yet", description = "Connect the API or create the first record." }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
      <div className="font-semibold text-slate-950">{title}</div>
      <div className="mt-2 text-sm text-slate-500">{description}</div>
    </div>
  );
}
