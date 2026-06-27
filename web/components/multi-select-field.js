"use client";

import { useState } from "react";

// Click-to-toggle chip multiselect. Replaces hand-typed comma-separated ID
// fields: the operator picks from real options instead of guessing IDs.
//
// Two modes:
//  - Uncontrolled (pass `name`): keeps internal state and emits a hidden input
//    with the comma-joined value the server action already expects.
//  - Controlled (pass `value` array + `onChange(ids)`): the parent owns state —
//    used where the value feeds a derived payload (e.g. the config JSON preview).
export function MultiSelectField({ label, name, options = [], defaultValue = [], value, onChange, help, emptyHint }) {
  const controlled = typeof onChange === "function";
  const [internal, setInternal] = useState(() => new Set(defaultValue));
  const selected = controlled ? new Set(value || []) : internal;

  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (controlled) onChange([...next]);
    else setInternal(next);
  }

  return (
    <label className="block">
      {label ? <span className="mb-2 block text-sm font-medium text-slate-700">{label}</span> : null}
      {name && !controlled ? <input type="hidden" name={name} value={[...selected].join(",")} /> : null}
      {options.length ? (
        <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-2.5">
          {options.map((option) => {
            const on = selected.has(option.id);
            return (
              <button
                type="button"
                key={option.id}
                onClick={() => toggle(option.id)}
                aria-pressed={on}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  on ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2.5 text-xs text-slate-400">{emptyHint}</p>
      )}
      {help ? <span className="mt-1 block text-xs text-slate-500">{help}</span> : null}
    </label>
  );
}
