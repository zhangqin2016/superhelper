"use client";

// "Keep this on your phone": once paired, the page offers to become a
// home-screen app, so closing the tab no longer means scanning again. The
// saved pairing reconnects when the app opens. Each browser gets the one
// thing that works there:
//   Chrome / Edge / Samsung (beforeinstallprompt)  → the system install dialog
//   iPhone Safari                                  → 分享 → 添加到主屏幕
//   WeChat / QQ / other in-app browsers            → open in a browser, or copy the link
// Hidden when already running as the installed app, or once dismissed.

import { useEffect, useState } from "react";

const DISMISS_KEY = "lily_m_install_hint_dismissed";

function environment() {
  const ua = navigator.userAgent || "";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const inApp = /MicroMessenger|QQ\/|WeiBo|DingTalk|Lark|AlipayClient/i.test(ua);
  const iosSafari = ios && !inApp && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  return { standalone, ios, inApp, iosSafari };
}

export function InstallHint({ onNotice }) {
  const [env, setEnv] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const e = environment();
    setEnv(e);
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === "1"; } catch { /* private mode */ }
    setHidden(e.standalone || dismissed);
    const onPrompt = (event) => { event.preventDefault(); setPrompt(event); };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden || !env) return null;
  const dismiss = () => {
    setHidden(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
  };
  const link = `${window.location.origin}/m/pair`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); onNotice?.("链接已复制，收藏到浏览器或发给自己"); } catch { onNotice?.(link); }
  };
  const install = async () => {
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    setPrompt(null);
    if (choice?.outcome === "accepted") setHidden(true);
  };

  const how = prompt ? "装到手机上，下次点图标就能直接控制电脑，不用再扫码。"
    : env.iosSafari ? "点 Safari 底部的「分享」→「添加到主屏幕」，下次点图标就能直接控制电脑。"
      : env.inApp ? "当前在 App 内置浏览器里，无法添加到桌面。请点右上角「…」→「在浏览器打开」，再添加到主屏幕；或先复制链接。"
        : "用浏览器菜单里的「添加到主屏幕 / 添加到桌面」，下次点图标就能直接控制电脑。";

  return (
    <div className="flex-shrink-0 border-b border-[#dbe7f8] bg-[#f0f6fe] px-4 py-2.5 text-xs leading-5 text-[#1d5aa8]" role="note">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1">{how}</p>
        <button type="button" onClick={dismiss} aria-label="不再提示" className="-mr-1 flex-shrink-0 px-1 text-base leading-5 text-[#6b8fc4]">×</button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {prompt ? <button type="button" onClick={install} className="rounded-full bg-[#2f7de1] px-3 py-1 font-semibold text-white active:bg-[#256bc4]">添加到主屏幕</button> : null}
        <button type="button" onClick={copy} className="rounded-full border border-[#bcd3f3] bg-white px-3 py-1 font-medium text-[#1d5aa8]">复制链接</button>
      </div>
    </div>
  );
}
