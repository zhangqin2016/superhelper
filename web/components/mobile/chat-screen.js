"use client";

// The conversation and the composer. Pure view over `messages(state)`; the
// actions come from the page.

import { useEffect, useRef, useState } from "react";
import { fileToDownscaledAttachment } from "../../lib/mobile/attachments.mjs";
import { renderMarkdown } from "./markdown";
import { PromptCard } from "./prompt-card";
import { useVoiceInput } from "./use-voice-input";

const STATUS_LABEL = {
  sending: "发送中",
  queued: "排队中…",
  running: "正在处理",
  failed: "出错了",
  stalled: "未完成",
  interrupted: "已停止",
};

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="正在处理">
      {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a9a397]" style={{ animationDelay: `${i * 140}ms` }} />)}
    </span>
  );
}

function UserBubble({ message }) {
  const text = message.text.length > 1500 ? `${message.text.slice(0, 1500)}…` : message.text;
  return (
    <div className="flex justify-end">
      <div className={`min-w-0 max-w-[85%] whitespace-pre-wrap rounded-2xl [overflow-wrap:anywhere] rounded-br-md bg-[#ecebe6] px-3.5 py-2 text-[15px] leading-6 text-[#1f2328] ${message.pending ? "opacity-70" : ""}`}>
        {message.files ? <div className="mb-1 text-xs text-[#6b665c]">🖼 {message.files} 张图片</div> : null}
        {text}
        {message.pending ? <div className="mt-0.5 text-right text-[11px] text-[#8a8479]">{STATUS_LABEL[message.status] || ""}</div> : null}
      </div>
    </div>
  );
}

const TODO_MARK = { completed: "✓", in_progress: "◐", cancelled: "✕", pending: "○" };

// The task list as the model wrote it — what is done, what runs now, what is next.
function TodoList({ todos }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="mt-2 rounded-xl border border-[#ebe8e1] bg-white px-3 py-2">
      <div className="text-xs font-medium text-[#6b665c]">任务进度 {done}/{todos.length}</div>
      <ul className="mt-1 space-y-0.5 text-[13px] leading-5">
        {todos.map((t, i) => (
          <li key={i} className={`flex gap-1.5 ${t.status === "completed" || t.status === "cancelled" ? "text-[#a9a397]" : t.status === "in_progress" ? "font-medium text-[#1f2328]" : "text-[#4a463f]"}`}>
            <span className={`w-3.5 flex-shrink-0 text-center ${t.status === "in_progress" ? "text-[#2f7de1]" : ""}`}>{TODO_MARK[t.status] || "○"}</span>
            <span className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${t.status === "cancelled" ? "line-through" : ""}`}>{t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const FILE_ICON = { image: "🖼", video: "🎬", audio: "🎵", document: "📄", spreadsheet: "📊", presentation: "📽", code: "⌨" };
const FILE_ERROR = { FILE_TOO_LARGE: "文件超过 20 MB，请在电脑上查看", FILE_NOT_FOUND: "电脑上找不到这个文件了", FILE_NOT_IN_CONVERSATION: "这个文件不属于当前会话" };

function sizeText(bytes) {
  if (!bytes) return "";
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The turn's produced files, as the desktop's cards list them; tap to fetch.
function FileList({ artifacts, downloads, onFile }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {artifacts.map((a) => {
        const state = downloads?.[a.artifactId] || null;
        const busy = state && !state.done && !state.error;
        return (
          <button key={a.artifactId} type="button" disabled={busy} onClick={() => onFile?.(a.artifactId)}
            className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[#ebe8e1] bg-white px-3 py-2 text-left active:bg-[#f7f5f1] disabled:opacity-70">
            <span className="flex-shrink-0 text-base">{FILE_ICON[a.kind] || "📎"}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[#1f2328]">{a.name}</span>
              <span className={`block text-xs ${state?.error ? "text-[#c8453b]" : "text-[#8a8479]"}`}>
                {state?.error ? (FILE_ERROR[state.error] || "没能取回，请重试") : busy ? `正在取回 ${Math.round((state.progress || 0) * 100)}%` : state?.done ? "已取回，再点一次重新打开" : [sizeText(a.bytes), "点一下取回到手机"].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AssistantBlock({ message, onStop, downloads, onFile }) {
  const running = message.live && message.status === "running";
  const label = message.status === "completed" ? "" : STATUS_LABEL[message.status] || "";
  const failed = message.status === "failed" || message.status === "stalled";
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#2f7de1] text-[11px] font-semibold text-white">L</div>
      <div className="min-w-0 flex-1 text-[15px] leading-6 text-[#1f2328]">
        {message.text ? <div className="space-y-1">{renderMarkdown(message.text)}</div> : (running ? <TypingDots /> : null)}
        {message.artifacts?.length ? <FileList artifacts={message.artifacts} downloads={downloads} onFile={onFile} /> : null}
        {running && message.todos?.length ? <TodoList todos={message.todos} /> : null}
        {running && (message.tool || message.steps) ? (
          <div className="mt-1.5 truncate text-xs text-[#8a8479]">
            {message.steps ? `已执行 ${message.steps} 步` : ""}{message.steps && message.tool ? " · " : ""}{message.tool ? `正在使用 ${message.tool}…` : ""}
          </div>
        ) : null}
        {label || running ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs">
            {label ? <span className={failed ? "text-[#c8453b]" : "text-[#8a8479]"}>{label}</span> : null}
            {running ? <button type="button" onClick={onStop} className="rounded-full border border-[#e2ded5] px-2.5 py-0.5 font-medium text-[#6b665c] active:bg-[#f1efe9]">停止</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Icon({ d, children }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[21px] w-[21px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d ? <path d={d} /> : children}
    </svg>
  );
}

function Composer({ client, offline, onSend, onNotice }) {
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState(null);
  const textRef = useRef(text);
  textRef.current = text;
  // Dictation renders the transcript live: what was typed + what is heard so far.
  const voice = useVoiceInput({ client, getText: () => textRef.current, onValue: setText, onNotice });

  const submit = () => {
    if (offline || (!text.trim() && !attachment)) return;
    if (onSend({ text, attachment })) { setText(""); setAttachment(null); }
    else onNotice("手机尚未连接电脑，任务未发送");
  };

  const pick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const prepared = await fileToDownscaledAttachment(file);
    if (prepared) setAttachment(prepared);
    else onNotice("图片无法处理（仅支持图片）");
  };

  return (
    <footer className="flex-shrink-0 border-t border-[#ebe8e1] bg-[#faf9f7] px-3 pb-[max(0.6rem,env(safe-area-inset-bottom))] pt-2">
      {attachment ? (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-[#ebe8e1] bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={attachment.preview} alt="" className="h-11 w-11 rounded-lg object-cover" />
          <span className="flex-1 truncate text-xs text-[#6b665c]">{attachment.name}</span>
          <button type="button" className="text-xs font-medium text-[#c8453b]" onClick={() => setAttachment(null)}>移除</button>
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-[22px] border border-[#e2ded5] bg-white p-1.5 focus-within:border-[#2f7de1]">
        <label className="flex h-9 w-9 flex-shrink-0 cursor-pointer items-center justify-center rounded-full text-[#6b665c] active:bg-[#f1efe9]" title="添加图片">
          <Icon><rect x="3" y="4.5" width="18" height="15" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m21 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L6 19.3" /></Icon>
          <input type="file" accept="image/*" className="hidden" onChange={pick} />
        </label>
        <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={offline ? "电脑离线，暂时无法发送" : voice.phase === "listening" ? "正在听，说完点麦克风…" : voice.phase === "connecting" ? "正在连接语音…" : voice.phase === "finishing" ? "正在整理刚才说的…" : "给电脑上的 Lily 派任务…"}
          className="max-h-32 min-h-[2.25rem] min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-base leading-6 placeholder:text-[#b9b4aa] focus:outline-none"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <button type="button" onClick={voice.toggle} title={voice.listening ? "停止语音输入" : "语音输入"} aria-pressed={voice.listening}
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition ${
            voice.phase === "listening" ? `bg-[#c8453b] text-white ${voice.speaking ? "ring-4 ring-[#f6d9d5]" : "animate-pulse ring-2 ring-[#f6d9d5]"}`
              : voice.phase === "connecting" || voice.phase === "finishing" ? "bg-[#f1efe9] text-[#8a8479] animate-pulse"
                : "text-[#6b665c] active:bg-[#f1efe9]"}`}>
          <Icon><rect x="9" y="3" width="6" height="11.5" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></Icon>
        </button>
        <button type="button" onClick={submit} disabled={offline || (!text.trim() && !attachment)} title="发送"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#2f7de1] text-white transition disabled:bg-[#dcd8cf] active:bg-[#256bc4]">
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true"><path d="M10 3.5a.9.9 0 0 1 .64.26l5 5a.9.9 0 1 1-1.28 1.28L10.9 6.58V16a.9.9 0 1 1-1.8 0V6.58L5.64 10.04a.9.9 0 1 1-1.28-1.28l5-5A.9.9 0 0 1 10 3.5Z" /></svg>
        </button>
      </div>
    </footer>
  );
}

export function ChatScreen({ conversation, messages, client, offline, onSend, onStop, onNotice, onAnswer, downloads, onFile }) {
  const scrollRef = useRef(null);
  const last = messages[messages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text, last?.status, conversation.prompts?.length]);
  const answer = (value) => { if (!onAnswer?.(value)) onNotice("手机尚未连接电脑，没能提交"); };

  return (
    <>
      <main ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4">
        {conversation.session === null ? <p className="mt-10 text-center text-sm text-[#a9a397]">正在读取电脑上的对话…</p> : null}
        {conversation.session && messages.length === 0 ? (
          <div className="mt-12 text-center">
            <div className="text-sm text-[#6b665c]">这个会话还没有消息</div>
            <div className="mt-1 text-xs text-[#a9a397]">发一个任务试试，或点 🎙 说话</div>
          </div>
        ) : null}
        {conversation.session?.truncated ? <p className="text-center text-xs text-[#a9a397]">更早的消息请在电脑上查看</p> : null}
        {messages.map((m) => (m.role === "user"
          ? <UserBubble key={m.key} message={m} />
          : <AssistantBlock key={m.key} message={m} onStop={onStop} downloads={downloads} onFile={(id) => { if (!onFile?.(id)) onNotice("手机尚未连接电脑"); }} />))}
        {(conversation.prompts || []).map((p) => (
          <PromptCard key={p.requestId} prompt={p} busy={Boolean(conversation.answering?.[p.requestId])} onAnswer={answer} />
        ))}
      </main>
      <Composer client={client} offline={offline} onSend={onSend} onNotice={onNotice} />
    </>
  );
}
