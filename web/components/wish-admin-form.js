"use client";

import { useActionState } from "react";
import { mergeWishAction, updateWishAction } from "../app/admin/actions";
import { Field, SelectField, SubmitButton, TextAreaField } from "./admin-forms";

const initialState = { ok: null, message: "" };
const json = (value) => JSON.stringify(value || {}, null, 2);

export function WishAdminForm({ wish, apps, skills, copy }) {
  const [updateState, updateAction, updatePending] = useActionState(updateWishAction, initialState);
  const [mergeState, mergeAction, mergePending] = useActionState(mergeWishAction, initialState);
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <form action={updateAction} className="table-card grid gap-5 p-6">
        <input type="hidden" name="id" value={wish.id} />
        <div className="rounded-xl bg-slate-50 p-5 text-sm text-slate-600">
          <div className="font-semibold text-slate-950">{copy.originalSubmission}</div>
          <p className="mt-3"><b>{wish.title}</b></p>
          <p className="mt-2 whitespace-pre-wrap">{wish.problem}</p>
          <p className="mt-2 whitespace-pre-wrap">{wish.desired_outcome}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField label={copy.status} name="status" defaultValue={wish.status} options={Object.keys(copy.statuses).filter((item) => item !== "merged")} />
          <SelectField label={copy.category} name="category" defaultValue={wish.category} options={Object.keys(copy.categories)} />
        </div>
        <Field label={copy.publicTitle} name="publicTitle" defaultValue={wish.public_title || ""} />
        <TextAreaField label={copy.publicSummary} name="publicSummary" rows={4} defaultValue={wish.public_summary || ""} />
        <TextAreaField label={copy.publicUpdate} name="publicUpdate" rows={3} defaultValue={wish.public_update || ""} />
        <div className="grid gap-4 md:grid-cols-2">
          <TextAreaField label={`${copy.publicTitle} i18n JSON`} name="publicTitleI18n" rows={5} defaultValue={json(wish.public_title_i18n)} />
          <TextAreaField label={`${copy.publicSummary} i18n JSON`} name="publicSummaryI18n" rows={5} defaultValue={json(wish.public_summary_i18n)} />
        </div>
        <TextAreaField label={`${copy.publicUpdate} i18n JSON`} name="publicUpdateI18n" rows={4} defaultValue={json(wish.public_update_i18n)} />
        <TextAreaField label={copy.submitterNote} name="submitterStatusNote" rows={3} defaultValue={wish.submitter_status_note || ""} />
        <Field label={copy.linkedApps} name="linkedAppIds" defaultValue={(wish.linked_app_ids || []).join(", ")} placeholder={apps.map((item) => item.app_id).join(", ")} />
        <Field label={copy.linkedSkills} name="linkedSkillIds" defaultValue={(wish.linked_skill_ids || []).join(", ")} placeholder={skills.map((item) => item.skill_id).join(", ")} />
        {updateState.message ? <p className={`rounded-lg px-4 py-3 text-sm ${updateState.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{updateState.message}</p> : null}
        <SubmitButton disabled={updatePending}>{updatePending ? copy.saving : copy.save}</SubmitButton>
      </form>
      <aside className="space-y-5">
        <div className="table-card p-6">
          <h2 className="text-lg font-semibold">{copy.deliveryLinks}</h2>
          <p className="mt-2 text-sm text-slate-500">{copy.deliveryHelp}</p>
          <div className="mt-4 text-xs text-slate-500">{apps.map((item) => item.app_id).join(" · ") || "-"}</div>
          <div className="mt-3 text-xs text-slate-500">{skills.map((item) => item.skill_id).join(" · ") || "-"}</div>
        </div>
        <form action={mergeAction} className="table-card p-6" onSubmit={(event) => { if (!window.confirm(copy.mergeConfirm)) event.preventDefault(); }}>
          <input type="hidden" name="id" value={wish.id} />
          <Field label={copy.mergeTarget} name="targetWishId" required />
          {mergeState.message ? <p className={`my-4 rounded-lg px-4 py-3 text-sm ${mergeState.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{mergeState.message}</p> : null}
          <div className="mt-4"><SubmitButton disabled={mergePending}>{mergePending ? copy.merging : copy.merge}</SubmitButton></div>
        </form>
      </aside>
    </div>
  );
}
