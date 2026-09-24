"use client";

// A card for each thing the desktop waits on this user for: approve a command
// or file change, approve a plan, allow a hook, or answer a question. What is
// asked comes from the desktop (src/main/mobile/prompt-view.js), the words from
// lib/mobile/prompt-copy; this renders them and sends the choice back.

import { useState } from "react";
import { promptCardView } from "../../lib/mobile/prompt-copy.mjs";

function ActionButtons({ prompt, view, busy, onAnswer }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {view.actions.map((a) => (
        <button key={a.id} type="button" disabled={busy} onClick={() => onAnswer({ requestId: prompt.requestId, action: a.id })}
          className={`min-h-[40px] rounded-xl px-4 text-sm font-semibold disabled:opacity-50 ${a.primary ? "bg-[#2f7de1] text-white active:bg-[#256bc4]" : a.danger ? "border border-[#f1d5d1] bg-white text-[#c8453b] active:bg-[#fdf1ef]" : "border border-[#e2ded5] bg-white text-[#4a463f] active:bg-[#f1efe9]"}`}>
          {a.label}
        </button>
      ))}
    </div>
  );
}

function QuestionForm({ prompt, view, busy, onAnswer }) {
  const questions = view.questions;
  const [picked, setPicked] = useState(() => questions.map(() => []));
  const [typed, setTyped] = useState(() => questions.map(() => ""));
  const toggle = (qi, label, multi) => setPicked((all) => all.map((sel, i) => {
    if (i !== qi) return sel;
    if (!multi) return [label];
    return sel.includes(label) ? sel.filter((v) => v !== label) : [...sel, label];
  }));
  const answers = questions.map((q, i) => (typed[i].trim() ? [...picked[i], typed[i].trim()] : picked[i]));
  const complete = answers.every((a) => a.length);
  return (
    <div className="mt-2 space-y-4">
      {questions.map((q, qi) => (
        <div key={qi}>
          <p className="text-sm leading-6 text-[#1f2328] [overflow-wrap:anywhere]">{q.question}</p>
          {q.options.length ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {q.options.map((o) => {
                const on = picked[qi].includes(o.label);
                return (
                  <button key={o.label} type="button" disabled={busy} aria-pressed={on} onClick={() => toggle(qi, o.label, q.multiSelect)}
                    className={`rounded-xl border px-3 py-2 text-left text-sm ${on ? "border-[#2f7de1] bg-[#eef4fd] text-[#1d5aa8]" : "border-[#e2ded5] bg-white text-[#1f2328]"}`}>
                    <span className="block font-medium [overflow-wrap:anywhere]">{o.label}</span>
                    {o.description ? <span className="mt-0.5 block text-xs text-[#6b665c] [overflow-wrap:anywhere]">{o.description}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <input type="text" value={typed[qi]} disabled={busy} onChange={(e) => setTyped((all) => all.map((v, i) => (i === qi ? e.target.value : v)))}
            placeholder={q.options.length ? "或者自己写…" : "写下你的回答"}
            className="mt-2 w-full rounded-xl border border-[#e2ded5] bg-white px-3 py-2 text-base focus:border-[#2f7de1] focus:outline-none" />
        </div>
      ))}
      <button type="button" disabled={busy || !complete} onClick={() => onAnswer({ requestId: prompt.requestId, answers })}
        className="min-h-[40px] w-full rounded-xl bg-[#2f7de1] text-sm font-semibold text-white active:bg-[#256bc4] disabled:bg-[#dcd8cf]">
        提交回答
      </button>
    </div>
  );
}

export function PromptCard({ prompt, busy, onAnswer }) {
  const view = promptCardView(prompt);
  return (
    <section className="rounded-2xl border border-[#f0d9a8] bg-[#fffaf0] p-3.5" aria-label={view.title}>
      <div className="flex items-center gap-2 text-xs font-semibold text-[#8a5a00]">
        <span className="inline-block h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-[#c98a14]" />
        {view.title}
      </div>
      {view.detail ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#1f2328] [overflow-wrap:anywhere]">{view.detail}</p> : null}
      {view.operation ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[#1f2328] p-2.5 font-mono text-[12px] leading-5 text-[#e6e3db] [overflow-wrap:anywhere]">{view.operation}</pre> : null}
      {prompt.kind === "question"
        ? <QuestionForm prompt={prompt} view={view} busy={busy} onAnswer={onAnswer} />
        : <ActionButtons prompt={prompt} view={view} busy={busy} onAnswer={onAnswer} />}
      {busy ? <p className="mt-2 text-xs text-[#8a8479]">正在提交…</p> : null}
    </section>
  );
}
