import { Bot, CheckCircle2, FolderKanban, Image, ListChecks, Search } from "lucide-react";

export function ProductWindow({ labels }) {
  const rows = labels.workspaces.map((row, index) => [...row, index === 0 ? "active" : "idle"]);
  return (
    <div className="product-window overflow-hidden rounded-2xl">
      <div className="flex h-12 items-center gap-2 border-b border-white/10 px-5">
        <span className="h-3 w-3 rounded-full bg-red-400" />
        <span className="h-3 w-3 rounded-full bg-yellow-400" />
        <span className="h-3 w-3 rounded-full bg-green-400" />
        <span className="ml-4 text-sm font-semibold text-white/70">Lily Workbench</span>
      </div>
      <div className="grid min-h-[520px] grid-cols-[260px_1fr]">
        <aside className="border-r border-white/10 bg-white/[0.03] p-5">
          <div className="mb-5 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">{labels.sidebar}</h3>
              <button className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/70">{labels.add}</button>
          </div>
          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row[0]} className={`rounded-xl p-4 ${row[2] === "active" ? "bg-white/12" : ""}`}>
                <div className="flex items-center gap-3 text-white">
                  <FolderKanban size={18} className="text-cyan" />
                  <span className="font-semibold">{row[0]}</span>
                </div>
                <p className="mt-2 truncate text-sm text-white/48">{row[1]}</p>
              </div>
            ))}
          </div>
        </aside>
        <main className="p-6">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h3 className="text-2xl font-semibold text-white">AI Assistant</h3>
              <p className="text-sm text-white/48">{labels.connected}</p>
            </div>
            <div className="flex gap-2">
              {[Image, Search, ListChecks].map((Icon, idx) => (
                <button key={idx} className="rounded-lg border border-white/10 p-3 text-white/65">
                  <Icon size={18} />
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-5">
            <div className="flex gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/8 text-sm font-semibold text-white">
                AI
              </div>
              <div className="max-w-[560px] rounded-2xl border border-white/10 bg-white px-5 py-4 text-slate-900 shadow-xl shadow-black/10">
                {labels.ai}
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <div className="rounded-2xl bg-brand px-5 py-4 font-semibold text-white">{labels.user}</div>
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">{labels.you}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
              <div className="mb-4 text-sm font-semibold text-white/70">{labels.result}</div>
              {labels.steps.map((item) => (
                <div key={item} className="mb-3 flex items-center gap-3 text-sm text-white/72 last:mb-0">
                  <CheckCircle2 size={17} className="text-cyan" />
                  {item}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3 pt-2">
              {labels.cards.map(([title, desc], index) => {
                const Icon = [Bot, Search, ListChecks][index];
                return (
                <div key={title} className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                  <Icon className="mb-3 text-cyan" size={22} />
                  <div className="font-semibold text-white">{title}</div>
                  <div className="mt-1 text-sm text-white/45">{desc}</div>
                </div>
              );})}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
