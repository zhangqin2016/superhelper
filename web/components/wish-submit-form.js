"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Send } from "lucide-react";
import { createWishAction, findSimilarWishesAction } from "../app/wishes/actions";
import { WishSupportButton } from "./wish-support-button";

const STORAGE_KEY = "lily_wish_draft_v1";
const emptyDraft = { title: "", problem: "", desiredOutcome: "", category: "other" };

export function WishSubmitForm({ locale, copy }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [similar, setSimilar] = useState([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") setDraft({ ...emptyDraft, ...saved });
    } catch {}
  }, []);

  useEffect(() => {
    if (!created) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [created, draft]);

  function update(key, value) {
    setCreated(false);
    setDraft((current) => ({ ...current, [key]: value }));
    setSimilar([]);
    setMessage("");
  }

  function login() {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    window.location.assign("/account/login?next=/wishes");
  }

  async function create() {
    setPending(true);
    setMessage("");
    const result = await createWishAction(draft);
    setPending(false);
    if (result.loginRequired) return login();
    if (!result.ok) {
      setMessage(result.message || copy.failed);
      return;
    }
    setCreated(true);
    setSimilar([]);
    setDraft(emptyDraft);
    sessionStorage.removeItem(STORAGE_KEY);
    setMessage(copy.success);
  }

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const result = await findSimilarWishesAction({ title: draft.title, locale });
    setPending(false);
    if (result.loginRequired) return login();
    if (!result.ok) {
      setMessage(result.message || copy.failed);
      return;
    }
    if (result.wishes.length) {
      setSimilar(result.wishes);
      return;
    }
    await create();
  }

  return (
    <form className="wish-submit-form" onSubmit={submit}>
      <div className="wish-submit-heading"><div><h2>{copy.formTitle}</h2><p>{copy.formDescription}</p></div><Send size={21} /></div>
      <label><span>{copy.titleLabel}</span><input required minLength={6} maxLength={160} value={draft.title} onChange={(event) => update("title", event.target.value)} placeholder={copy.titlePlaceholder} /></label>
      <div className="wish-form-grid">
        <label><span>{copy.problemLabel}</span><textarea required minLength={12} maxLength={2000} rows={5} value={draft.problem} onChange={(event) => update("problem", event.target.value)} /></label>
        <label><span>{copy.outcomeLabel}</span><textarea required minLength={12} maxLength={2000} rows={5} value={draft.desiredOutcome} onChange={(event) => update("desiredOutcome", event.target.value)} /></label>
      </div>
      <label><span>{copy.categoryLabel}</span><select value={draft.category} onChange={(event) => update("category", event.target.value)}>{Object.entries(copy.categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {similar.length ? (
        <div className="wish-similar"><h3>{copy.similarTitle}</h3><p>{copy.similarDescription}</p>{similar.map((wish) => <div className="wish-similar-row" key={wish.id}><div><b>{wish.title}</b><span>{wish.summary}</span></div><WishSupportButton wishId={wish.id} label={copy.alsoNeed} /></div>)}<button type="button" className="wish-create-anyway" disabled={pending} onClick={create}>{copy.createAnyway}<ArrowRight size={15} /></button></div>
      ) : null}
      {message ? <p className={created ? "wish-form-success" : "wish-form-error"} role="status">{message}</p> : null}
      {!similar.length ? <button className="wish-submit-button" disabled={pending}>{pending ? copy.sending : copy.submit}</button> : null}
      <p className="wish-form-privacy">{copy.privacy}</p>
    </form>
  );
}
