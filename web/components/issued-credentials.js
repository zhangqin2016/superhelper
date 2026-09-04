"use client";

import { useEffect, useState } from "react";

/**
 * Shows the credentials the company just issued — exactly once.
 *
 * Initial passwords come back from the API a single time and are never stored,
 * so the server action carries them here through the URL hash, which never
 * reaches the server. This component reads it, renders it, and clears it, so a
 * reload or a shared link shows nothing.
 */
export default function IssuedCredentials() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const match = /#issued=([A-Za-z0-9_-]+)/.exec(window.location.hash || "");
    if (!match) return;
    try {
      const decoded = JSON.parse(atob(match[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (Array.isArray(decoded)) setRows(decoded.filter((r) => r && r.l && r.p));
    } catch {
      setRows([]);
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  if (!rows.length) return null;
  const text = rows.map((r) => `${r.l}\t${r.p}`).join("\n");
  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">已生成 {rows.length} 个账户 — 初始密码只显示这一次</h2>
          <p className="mt-1 text-xs text-slate-600">请现在复制并发给对应员工。刷新页面后将不再显示；如遗失可对该账户"重置密码"。员工首次登录会被要求设置新密码。</p>
        </div>
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(text)}
          className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
        >
          复制全部
        </button>
      </div>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="py-1 pr-4 font-medium">登录名</th>
            <th className="py-1 font-medium">初始密码</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr key={r.l} className="border-t border-emerald-100">
              <td className="py-1.5 pr-4 text-slate-900">{r.l}</td>
              <td className="py-1.5 text-slate-900">{r.p}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
