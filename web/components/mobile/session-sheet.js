"use client";

// Bottom sheet: which workspace and session this phone drives. Pure view.
//
// Both are lists, not chips: a person can have a dozen workspaces with long
// names, and wrapped chips grew past the sheet and off the screen. The sheet is
// sized to the visible viewport (dvh), and each list scrolls on its own, so
// neither can push the other — or the Done button — out of reach.

function Row({ label, selected, onClick }) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-pressed={selected}
        className={`flex w-full min-w-0 items-center gap-2 px-3.5 py-3 text-left text-sm active:bg-[#f7f5f1] ${selected ? "bg-[#f3f7fe] font-medium text-[#1d5aa8]" : "text-[#1f2328]"}`}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {selected ? <span className="flex-shrink-0 text-xs font-semibold">✓</span> : null}
      </button>
    </li>
  );
}

export function SessionSheet({ projects, selectedProjectId, sessions, selectedSessionId, onSelectProject, onSelectSession, onClose }) {
  const list = "min-h-0 overflow-y-auto overscroll-contain divide-y divide-[#efece6] rounded-2xl border border-[#ebe8e1] bg-white";
  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/25" onClick={onClose}>
      <div className="mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-3xl bg-[#faf9f7] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 flex-shrink-0 rounded-full bg-[#dcd8cf]" />
        <h2 className="flex-shrink-0 text-xs font-semibold text-[#8a8479]">工作空间</h2>
        {projects.length ? (
          <ul className={`mt-2 max-h-[30dvh] flex-shrink-0 ${list}`}>
            {projects.map((p) => <Row key={p.id} label={p.name || "未命名工作空间"} selected={p.id === selectedProjectId} onClick={() => onSelectProject(p.id)} />)}
          </ul>
        ) : <p className="mt-2 flex-shrink-0 text-xs text-[#a9a397]">仅当前工作空间</p>}
        <h2 className="mt-4 flex-shrink-0 text-xs font-semibold text-[#8a8479]">会话</h2>
        <ul className={`mt-2 ${list}`}>
          {sessions.length
            ? sessions.map((s) => <Row key={s.id} label={s.title || "未命名会话"} selected={s.id === selectedSessionId} onClick={() => onSelectSession(s.id)} />)
            : <li className="px-3.5 py-3 text-xs text-[#a9a397]">该工作空间暂无会话</li>}
        </ul>
        <button type="button" className="mt-3 w-full flex-shrink-0 rounded-xl border border-[#e2ded5] bg-white py-2.5 text-sm font-medium text-[#4a463f]" onClick={onClose}>完成</button>
      </div>
    </div>
  );
}
