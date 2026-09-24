"use client";

// "Notify me": the switch for task notifications while the page is closed.
// It says plainly when this phone cannot get them (iPhone outside the
// installed app, a browser without web push, notifications denied).

import { useEffect, useState } from "react";
import { currentSubscription, disablePush, enablePush, pushSupport } from "../../lib/mobile/push.mjs";

const WHY = {
  unsupported: "这个浏览器不支持通知。",
  ios_needs_install: "iPhone 需要先把本页「添加到主屏幕」，从主屏幕打开后才能开启通知。",
  denied: "通知权限被关闭了，请在浏览器或系统设置里允许本站通知。",
  no_key: "服务暂时不可用，请稍后再试。",
  subscribe_failed: "这个浏览器的推送服务连接不上（部分安卓浏览器在国内无法使用推送）。",
  save_failed: "没能保存，请稍后再试。",
  worker_failed: "没能启用，请刷新页面后再试。",
};

export function PushToggle({ client, onNotice }) {
  const [state, setState] = useState({ ready: false, on: false, busy: false, reason: "" });

  useEffect(() => {
    let alive = true;
    const support = pushSupport();
    void currentSubscription().then((sub) => {
      if (alive) setState({ ready: true, on: Boolean(sub) && support.supported, busy: false, reason: support.supported ? "" : support.reason });
    });
    return () => { alive = false; };
  }, []);

  if (!state.ready) return null;
  const toggle = async () => {
    if (!client) return;
    setState((s) => ({ ...s, busy: true }));
    const result = state.on ? await disablePush(client) : await enablePush(client);
    if (result.ok) {
      setState((s) => ({ ...s, busy: false, on: !s.on, reason: "" }));
      onNotice?.(state.on ? "已关闭通知" : "已开启：任务完成或需要你确认时会通知你");
    } else {
      setState((s) => ({ ...s, busy: false, reason: result.reason }));
    }
  };
  const unavailable = state.reason && !state.on;

  return (
    <div className="mt-4 flex-shrink-0 rounded-2xl border border-[#ebe8e1] bg-white px-3.5 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[#1f2328]">任务完成时通知我</div>
          <div className="mt-0.5 text-xs leading-5 text-[#8a8479]">{unavailable ? WHY[state.reason] || WHY.unsupported : "关掉页面也能收到：任务完成、或需要你批准时提醒。不含对话内容。"}</div>
        </div>
        {state.reason === "ios_needs_install" || state.reason === "unsupported" ? null : (
          <button type="button" role="switch" aria-checked={state.on} disabled={state.busy} onClick={toggle}
            className={`relative h-7 w-12 flex-shrink-0 rounded-full transition disabled:opacity-60 ${state.on ? "bg-[#2f7de1]" : "bg-[#dcd8cf]"}`}>
            <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${state.on ? "left-[22px]" : "left-0.5"}`} />
          </button>
        )}
      </div>
    </div>
  );
}
