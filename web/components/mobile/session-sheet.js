"use client";

// Bottom sheet: which workspace and session this phone drives. Pure view.

export function SessionSheet({ projects, selectedProjectId, sessions, selectedSessionId, onSelectProject, onSelectSession, onClose }) {
  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/25" onClick={onClose}>
      <div className="max-h-[78vh] overflow-y-auto rounded-t-3xl bg-[#faf9f7] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#dcd8cf]" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[#8a8479]">工作空间</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {projects.length ? projects.map((p) => (
            <button key={p.id} type="button" onClick={() => onSelectProject(p.id)}
              className={`rounded-full border px-3 py-1.5 text-sm ${p.id === selectedProjectId ? "border-[#2f7de1] bg-[#eef4fd] text-[#1d5aa8]" : "border-[#e2ded5] bg-white text-[#4a463f]"}`}>
              {p.name || "未命名工作空间"}
            </button>
          )) : <span className="text-xs text-[#a9a397]">仅当前工作空间</span>}
        </div>
        <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-[#8a8479]">会话</h2>
        <ul className="mt-2 divide-y divide-[#efece6] overflow-hidden rounded-2xl border border-[#ebe8e1] bg-white">
          {sessions.length ? sessions.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onSelectSession(s.id)}
                className={`flex w-full items-center gap-2 px-3.5 py-3 text-left text-sm active:bg-[#f7f5f1] ${s.id === selectedSessionId ? "text-[#1d5aa8]" : "text-[#1f2328]"}`}>
                <span className="flex-1 truncate">{s.title || "未命名会话"}</span>
                {s.id === selectedSessionId ? <span className="text-xs font-semibold">✓</span> : null}
              </button>
            </li>
          )) : <li className="px-3.5 py-3 text-xs text-[#a9a397]">该工作空间暂无会话</li>}
        </ul>
        <button type="button" className="mt-4 w-full rounded-xl border border-[#e2ded5] bg-white py-2.5 text-sm font-medium text-[#4a463f]" onClick={onClose}>完成</button>
      </div>
    </div>
  );
}
