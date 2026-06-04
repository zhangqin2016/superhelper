"use client";

import { useState } from "react";
import { Send } from "lucide-react";

const initialState = { ok: null, code: "" };

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function ContactForm({ labels, source = "website" }) {
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = {
      name: text(formData, "name"),
      email: text(formData, "email"),
      company: text(formData, "company") || null,
      phone: text(formData, "phone") || null,
      subject: text(formData, "subject") || null,
      message: text(formData, "message"),
      source: text(formData, "source") || "website",
    };
    if (!payload.name || !payload.email || payload.message.length < 8) {
      setState({ ok: false, code: "required" });
      return;
    }
    setPending(true);
    const response = await fetch("/api/contact-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      const json = await response?.json().catch(() => ({}));
      setState({ ok: false, code: json?.code === "VALIDATION_ERROR" ? "required" : "failed" });
      return;
    }
    form.reset();
    setState({ ok: true, code: "success" });
  }

  return (
    <form onSubmit={submit} className="table-card grid gap-4 p-6">
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
        <textarea name="message" required minLength={8} rows={5} className="resize-none rounded-lg border border-slate-200 px-3 py-3 font-normal leading-7 outline-none focus:border-brand" />
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
