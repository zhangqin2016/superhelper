"use client";

import { useState } from "react";
import { enterpriseConsoleText, fill } from "../lib/enterprise-console-i18n.mjs";

/**
 * The initial passwords an issue or reset just returned — shown exactly once.
 *
 * They come back from the API a single time and are never stored; they live
 * only in this form's result, so a reload or a shared link shows nothing.
 * (The platform console's IssuedCredentials is Chinese-only; this is the same
 * receipt in the viewer's language.)
 */
export default function EnterpriseCredentials({ credentials = [], locale }) {
  const text = enterpriseConsoleText(locale).credentials;
  const [copied, setCopied] = useState(false);
  const rows = (Array.isArray(credentials) ? credentials : []).filter((row) => row && row.l && row.p);
  if (!rows.length) return null;
  const all = rows.map((row) => `${row.l}\t${row.p}`).join("\n");
  return (
    <section className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{fill(text.title, { n: rows.length })}</h3>
          <p className="mt-1 text-xs text-slate-600">{text.body}</p>
        </div>
        <button
          type="button"
          onClick={() => { navigator.clipboard?.writeText(all).then(() => setCopied(true), () => setCopied(false)); }}
          className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
        >
          {copied ? text.copied : text.copyAll}
        </button>
      </div>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-start text-xs text-slate-500">
            <th className="py-1 pe-4 text-start font-medium">{text.colLogin}</th>
            <th className="py-1 text-start font-medium">{text.colPassword}</th>
          </tr>
        </thead>
        <tbody className="font-mono" dir="ltr">
          {rows.map((row) => (
            <tr key={row.l} className="border-t border-emerald-100">
              <td className="py-1.5 pe-4 text-start text-slate-900">{row.l}</td>
              <td className="py-1.5 text-start text-slate-900 select-all">{row.p}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
