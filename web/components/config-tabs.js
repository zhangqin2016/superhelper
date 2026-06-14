"use client";

import { useState } from "react";

/**
 * Generic tabbed container for the config page. Sections are passed in as
 * already-rendered nodes (built in the server page), so this client component
 * only owns the active-tab state — no data fetching, no coupling to the
 * sections. All sections stay mounted (toggled with `hidden`) so form state in
 * a tab survives switching away and back.
 *
 * @param {{ tabs: Array<{ id: string, label: string, node: React.ReactNode }> }} props
 */
export function ConfigTabs({ tabs = [] }) {
  const [active, setActive] = useState(tabs[0]?.id || "");

  return (
    <div>
      <div className="mb-6 flex flex-wrap gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              active === tab.id
                ? "bg-white text-brand shadow-sm ring-1 ring-slate-200"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} className={active === tab.id ? "" : "hidden"}>
          {tab.node}
        </div>
      ))}
    </div>
  );
}
