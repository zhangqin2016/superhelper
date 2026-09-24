"use client";

// Pairing: scan (or paste) the desktop's QR, or type a direct code. Pure view.

import { useState } from "react";

const BUSY = new Set(["pairing", "waiting", "connecting"]);

export function PairingScreen({ status, capabilitiesNote, onPair, onDirectConnect }) {
  const [mode, setMode] = useState("scan");
  const [code, setCode] = useState("");
  const [direct, setDirect] = useState({ code: "", password: "" });
  const busy = BUSY.has(status.phase);
  const failed = status.phase === "error" || status.phase === "ended";

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5">
      {status.message ? (
        <p className={`mb-4 rounded-xl border px-3.5 py-2.5 text-sm leading-6 ${failed ? "border-[#f1d5d1] bg-[#fdf1ef] text-[#8f2f27]" : "border-[#dbe7f8] bg-[#f0f6fe] text-[#1d5aa8]"}`}>
          {busy ? <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]" /> : null}
          {status.message}
        </p>
      ) : null}
      <div className="flex gap-1 rounded-xl bg-[#efece6] p-1 text-sm">
        {[["scan", "扫码 / 配对码"], ["direct", "授权码直连"]].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setMode(id)}
            className={`flex-1 rounded-lg py-2 font-medium transition ${mode === id ? "bg-white text-[#1f2328] shadow-sm" : "text-[#8a8479]"}`}>{label}</button>
        ))}
      </div>
      <div className="mt-3 rounded-2xl border border-[#ebe8e1] bg-white p-4">
        {mode === "scan" ? (
          <>
            <ol className="space-y-2 text-sm leading-6 text-[#4a463f]">
              {["在电脑上打开 Lily「设置 → 手机控制」", "点「扫码配对」，用手机相机扫二维码", "在电脑上点「批准」"].map((step, i) => (
                <li key={step}><span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#eef4fd] text-xs font-semibold text-[#2f7de1]">{i + 1}</span>{step}</li>
              ))}
            </ol>
            <label className="mt-4 block text-xs font-medium text-[#8a8479]" htmlFor="pair-code">扫不了码？粘贴配对码</label>
            <input id="pair-code" className="mt-1.5 w-full rounded-xl border border-[#e2ded5] bg-[#faf9f7] px-3 py-2.5 text-base focus:border-[#2f7de1] focus:outline-none"
              value={code} onChange={(e) => setCode(e.target.value)} placeholder="粘贴电脑显示的配对码" />
            <button type="button" disabled={busy} onClick={() => onPair(code)}
              className="mt-3 w-full rounded-xl bg-[#2f7de1] py-3 text-sm font-semibold text-white active:bg-[#256bc4] disabled:opacity-60">{busy ? "连接中…" : "配对并连接"}</button>
          </>
        ) : (
          <>
            <p className="text-sm leading-6 text-[#4a463f]">在电脑上点「直控码」，把授权码和密码输入到这里，无需在电脑上批准。</p>
            {[["code", "授权码"], ["password", "密码"]].map(([field, label]) => (
              <input key={field} aria-label={label} placeholder={label} autoCapitalize="characters"
                className="mt-2 w-full rounded-xl border border-[#e2ded5] bg-[#faf9f7] px-3 py-2.5 text-center font-mono text-lg uppercase tracking-[0.3em] focus:border-[#2f7de1] focus:outline-none"
                value={direct[field]} onChange={(e) => setDirect((d) => ({ ...d, [field]: e.target.value }))} />
            ))}
            <button type="button" disabled={busy} onClick={() => onDirectConnect(direct.code, direct.password)}
              className="mt-3 w-full rounded-xl bg-[#2f7de1] py-3 text-sm font-semibold text-white active:bg-[#256bc4] disabled:opacity-60">{busy ? "连接中…" : "直接连接"}</button>
            <p className="mt-2 text-xs text-[#8a8479]">直连无需电脑批准，请只在你信任的网络输入。</p>
          </>
        )}
      </div>
      {capabilitiesNote ? <p className="mt-4 text-xs leading-5 text-[#a9a397]">{capabilitiesNote}</p> : null}
    </main>
  );
}
