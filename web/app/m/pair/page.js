"use client";

// Mobile Command — the phone page. Composition only:
//   useMobileCommand   connection (lib/mobile/relay-client) + conversation
//                      (lib/mobile/conversation), wired together
//   PairingScreen      scan / paste / direct code
//   ChatScreen         the desktop's conversation, the live turn, the composer
//   SessionSheet       which workspace + session this phone drives
//
// No login: the phone presents a browser device id, consumes the desktop's
// one-time QR token and receives a grant-scoped token that can only relay for
// that pairing. Security is QR possession + the desktop user's approval.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatScreen } from "../../../components/mobile/chat-screen";
import { InstallHint } from "../../../components/mobile/install-hint";
import { PairingScreen } from "../../../components/mobile/pairing-screen";
import { SessionSheet } from "../../../components/mobile/session-sheet";
import { useMobileCommand } from "../../../components/mobile/use-mobile-command";

function StatusDot({ tone, pulse }) {
  const color = { ok: "bg-[#1f9d61]", busy: "bg-[#2f7de1]", warn: "bg-[#c98a14]", bad: "bg-[#c8453b]" }[tone] || "bg-[#b9b4aa]";
  return <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${color} ${pulse ? "animate-pulse" : ""}`} />;
}

function useToast() {
  const [toast, setToast] = useState("");
  const timer = useRef(null);
  const show = useCallback((text) => {
    setToast(String(text || ""));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 3500);
  }, []);
  return [toast, show];
}

export default function MobilePairPage() {
  const { status, conversation, messages, busy, client, actions } = useMobileCommand();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, showToast] = useToast();
  const [capabilitiesNote, setCapabilitiesNote] = useState("");

  // What the desktop reports as noteworthy (a rejection, a failed switch…) is a toast.
  useEffect(() => { if (conversation.notice) showToast(conversation.notice.text); }, [conversation.notice, showToast]);

  useEffect(() => {
    fetch(`${window.location.origin}/api/mobile/capabilities`).then((r) => r.json()).then((json) => {
      const caps = json?.capabilities;
      if (caps && !(caps.observeControl?.enabled || caps.voice?.enabled)) {
        setCapabilitiesNote("当前支持：任务、图片、回复、历史、工作空间/会话选择、语音听写。屏幕、鼠标键盘控制暂未开放。");
      }
    }).catch(() => { /* informational only */ });
  }, []);

  const online = status.phase === "online";
  const reconnecting = status.phase === "reconnecting";
  const inSession = online || reconnecting;
  const offline = online && conversation.desktopOnline === false;
  const tone = !inSession ? (status.phase === "error" || status.phase === "ended" ? "bad" : "idle") : offline || reconnecting ? "warn" : busy ? "busy" : "ok";
  const statusText = !inSession
    ? ({ pairing: "配对中", waiting: "等待批准", connecting: "连接中", error: "未连接", ended: "已解除" }[status.phase] || "未配对")
    : reconnecting ? "重连中" : offline ? "电脑离线" : busy ? "处理中" : "在线";
  const workspace = conversation.projects.find((p) => p.id === conversation.selectedProjectId)?.name || "工作空间";
  const sessionTitle = conversation.sessions.find((s) => s.id === conversation.selectedSessionId)?.title || conversation.session?.title || "当前会话";

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden bg-[#faf9f7] text-[#1f2328]" style={{ colorScheme: "light" }}>
      <header className="flex-shrink-0 border-b border-[#ebe8e1] bg-[#faf9f7]/95 px-4 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center gap-2">
          {inSession ? (
            <button type="button" onClick={() => setSheetOpen(true)} className="min-w-0 flex-1 text-left active:opacity-70">
              <div className="truncate text-[15px] font-semibold">{sessionTitle}</div>
              <div className="truncate text-xs text-[#8a8479]">{workspace} · 切换 ▾</div>
            </button>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">手机控制 Lily</div>
              <div className="text-xs text-[#8a8479]">把任务发给你电脑上的 Lily</div>
            </div>
          )}
          <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border border-[#e2ded5] bg-white px-2.5 py-1 text-xs text-[#4a463f]">
            <StatusDot tone={tone} pulse={busy || reconnecting} />
            {statusText}
          </span>
        </div>
      </header>

      {offline ? (
        <div className="flex-shrink-0 border-b border-[#f0e2c2] bg-[#fdf6e7] px-4 py-2 text-xs leading-5 text-[#7a5a14]">
          电脑上的 Lily 暂时不在线（可能已关闭或休眠）。它上线后这里会自动恢复。
        </div>
      ) : null}
      {online ? <InstallHint onNotice={showToast} /> : null}
      {reconnecting ? (
        <div className="flex-shrink-0 border-b border-[#ebe8e1] bg-[#f4f2ed] px-4 py-2 text-xs text-[#6b665c]">{status.message}</div>
      ) : null}

      {inSession ? (
        <ChatScreen
          conversation={conversation}
          messages={messages}
          client={client}
          offline={offline}
          onSend={actions.send}
          onStop={actions.stop}
          onNotice={showToast}
        />
      ) : (
        <PairingScreen status={status} capabilitiesNote={capabilitiesNote} onPair={actions.pair} onDirectConnect={actions.directConnect} />
      )}

      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center px-6">
          <p className="rounded-lg bg-[#1f2328]/90 px-3 py-1.5 text-center text-xs text-white">{toast}</p>
        </div>
      ) : null}

      {sheetOpen ? (
        <SessionSheet
          projects={conversation.projects}
          selectedProjectId={conversation.selectedProjectId}
          sessions={conversation.sessions}
          selectedSessionId={conversation.selectedSessionId}
          onSelectProject={actions.selectProject}
          onSelectSession={(id) => { actions.selectSession(id); setSheetOpen(false); }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}
