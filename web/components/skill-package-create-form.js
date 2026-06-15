"use client";

import { useActionState } from "react";
import { createSkillPackageAction } from "../app/admin/actions";
import { CheckboxField, Field, SelectField, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };

export function SkillPackageCreateForm() {
  const [state, action, pending] = useActionState(createSkillPackageAction, initialState);
  const { t } = useI18n();

  return (
    <div className="table-card mb-6 p-6">
      <h2 className="mb-5 text-xl font-semibold">{t.admin.pages.skillPackages[0]}</h2>
      <p className="mb-4 text-sm text-slate-500">
        上传 .skillpack.zip 后会自动发布到七牛云，并写入 SHA256、大小和下载地址。
      </p>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <Field label="Skill ID" name="skillId" placeholder="lily-coding-core" required />
        <Field label="Name" name="name" placeholder="编程创作增强" required />
        <Field label="Version" name="version" defaultValue="1.0.0" required />
        <SelectField label="Category" name="category" defaultValue="coding" options={["core", "coding", "design", "media", "office", "research", "quality", "professional"]} />
        <SelectField label="Capability" name="capabilityLayer" defaultValue="coding-core" options={["intent-core", "coding-core", "design-core", "media-core", "office-core", "research-core", "professional-pack"]} />
        <SelectField label="Risk" name="riskLevel" defaultValue="low" options={["low", "medium", "high"]} />
        <div className="lg:col-span-3">
          <Field label="Skill pack zip" name="artifact" type="file" required />
        </div>
        <Field label="Min app version" name="minAppVersion" placeholder="0.1.40" />
        <SelectField label="Channel" name="channel" defaultValue="stable" options={["stable", "beta", "experimental"]} />
        <Field label="Publisher" name="publisher" defaultValue="Lily Workbench" />
        <Field label="Source repo" name="sourceRepo" placeholder="lily-workbench/skills" />
        <div className="lg:col-span-2">
          <Field label="Description" name="description" />
        </div>
        <div className="flex items-end">
          <CheckboxField label="Default eligible" name="defaultEligible" />
        </div>
        <div className="flex items-end">
          <CheckboxField label="Featured" name="featured" />
        </div>
        <div className="flex items-end">
          <CheckboxField label="Disabled" name="disabled" />
        </div>
        <div className="flex items-end">
          <SubmitButton disabled={pending}>{pending ? "..." : t.admin.pages.skillPackages[0]}</SubmitButton>
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
