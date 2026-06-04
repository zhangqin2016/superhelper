"use client";

import { useActionState } from "react";
import { createPluginAction } from "../app/admin/actions";
import { CheckboxField, Field, SelectField, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };

export function PluginCreateForm() {
  const [state, action, pending] = useActionState(createPluginAction, initialState);
  const { t } = useI18n();

  return (
    <div className="table-card mb-6 p-6">
      <h2 className="mb-5 text-xl font-semibold">{t.admin.pages.plugins[0]}</h2>
      <p className="mb-4 text-sm text-slate-500">
        {t.admin.pages.plugins[1]}
      </p>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <Field label="Plugin ID" name="id" placeholder="weather" required />
        <Field label="Name" name="name" placeholder="Weather MCP" required />
        <SelectField label="Type" name="type" defaultValue="mcp" options={["mcp", "skill", "tool"]} />
        <Field label="Version" name="version" defaultValue="1.0.0" required />
        <div className="lg:col-span-2">
          <Field label="Package URL" name="manifestUrl" placeholder="https://qny.../*.skillpack.zip" required />
        </div>
        <div className="lg:col-span-2">
          <Field label="Description" name="description" />
        </div>
        <Field label="SHA256" name="sha256" placeholder="Required for client install" />
        <div className="flex items-end">
          <CheckboxField label="Disabled" name="disabled" />
        </div>
        <div className="flex items-end">
          <SubmitButton disabled={pending}>{pending ? "..." : t.admin.pages.plugins[0]}</SubmitButton>
        </div>
      </form>
      {state?.message ? (
        <p className={`mt-4 rounded-lg px-4 py-3 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
