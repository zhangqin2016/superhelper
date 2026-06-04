"use client";

import { useActionState } from "react";
import { Send } from "lucide-react";
import { submitContactAction } from "../app/contact/actions";

const initialState = { ok: null, code: "" };

export function ContactForm({ labels, source = "website" }) {
  const [state, action, pending] = useActionState(submitContactAction, initialState);
  return (
    <form action={action} className="table-card grid gap-4 p-6">
      <input type="hidden" name="source" value={source} />
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-semibold text-slate-700">
          {labels.name}
          <input name="name" required className="rounded-lg border border-slate-200 px-3 py-3 font-normal outline-none focus:border-brand" />
        </label>
        <label className="grid gap-2 text-sm font-semibold text-slate-700">
          {labels.email}
          <input name="email" type="email" required className="rounded-lg border border-slate-200 px-3 py-3 font-normal outline-none focus:border-brand" />
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-semibold text-slate-700">
          {labels.company}
          <input name="company" className="rounded-lg border border-slate-200 px-3 py-3 font-normal outline-none focus:border-brand" />
        </label>
        <label className="grid gap-2 text-sm font-semibold text-slate-700">
          {labels.phone}
          <input name="phone" className="rounded-lg border border-slate-200 px-3 py-3 font-normal outline-none focus:border-brand" />
        </label>
      </div>
      <label className="grid gap-2 text-sm font-semibold text-slate-700">
        {labels.subject}
        <input name="subject" className="rounded-lg border border-slate-200 px-3 py-3 font-normal outline-none focus:border-brand" />
      </label>
      <label className="grid gap-2 text-sm font-semibold text-slate-700">
        {labels.message}
        <textarea name="message" required rows={5} className="resize-none rounded-lg border border-slate-200 px-3 py-3 font-normal leading-7 outline-none focus:border-brand" />
      </label>
      {state?.code ? (
        <p className={`rounded-lg px-4 py-3 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {labels[state.code]}
        </p>
      ) : null}
      <button className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={pending}>
        <Send size={17} />
        {pending ? labels.sending : labels.submit}
      </button>
    </form>
  );
}
