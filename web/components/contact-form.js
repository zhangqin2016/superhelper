"use client";

import { useState } from "react";
import { Send } from "lucide-react";

const initialState = { ok: null, code: "" };

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

// The server contract is unchanged: the chosen topic travels in `subject`
// ("企业开通与采购 · <subject>") so no new field reaches /api/contact-requests.
export function ContactForm({ labels, source = "website", topics = null, topicLabel = "", initialTopic = "" }) {
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState(false);
  const topicEntries = topics ? Object.entries(topics) : [];
  const defaultTopic = topicEntries.some(([key]) => key === initialTopic) ? initialTopic : topicEntries[0]?.[0] || "";

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const topic = topics?.[text(formData, "topic")] || "";
    const subject = [topic, text(formData, "subject")].filter(Boolean).join(" · ").slice(0, 160);
    const payload = {
      name: text(formData, "name"),
      email: text(formData, "email"),
      company: text(formData, "company") || null,
      phone: text(formData, "phone") || null,
      subject: subject || null,
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
    <form onSubmit={submit} className="ct-form site-card">
      <input type="hidden" name="source" value={source} />
      {topicEntries.length ? (
        <label className="ct-field">
          <span>{topicLabel}</span>
          <select name="topic" defaultValue={defaultTopic}>
            {topicEntries.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      ) : null}
      <div className="ct-row">
        <label className="ct-field">
          <span>{labels.name}</span>
          <input name="name" required autoComplete="name" />
        </label>
        <label className="ct-field">
          <span>{labels.email}</span>
          <input name="email" type="email" required autoComplete="email" />
        </label>
      </div>
      <div className="ct-row">
        <label className="ct-field">
          <span>{labels.company}</span>
          <input name="company" autoComplete="organization" />
        </label>
        <label className="ct-field">
          <span>{labels.phone}</span>
          <input name="phone" autoComplete="tel" />
        </label>
      </div>
      <label className="ct-field">
        <span>{labels.subject}</span>
        <input name="subject" maxLength={120} />
      </label>
      <label className="ct-field">
        <span>{labels.message}</span>
        <textarea name="message" required minLength={8} rows={6} />
      </label>
      {state?.code ? (
        <p className={`ct-status ${state.ok ? "ct-status--ok" : "ct-status--error"}`} role="status">
          {labels[state.code]}
        </p>
      ) : null}
      <button className="site-btn site-btn--primary ct-submit" disabled={pending}>
        <Send size={16} aria-hidden="true" />
        {pending ? labels.sending : labels.submit}
      </button>
    </form>
  );
}
