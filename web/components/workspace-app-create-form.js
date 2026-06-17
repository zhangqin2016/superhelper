"use client";

import { useActionState } from "react";
import { createWorkspaceAppAction } from "../app/admin/actions";
import { CheckboxField, Field, SelectField, SubmitButton, TextAreaField } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };

export function WorkspaceAppCreateForm() {
  const [state, action, pending] = useActionState(createWorkspaceAppAction, initialState);
  const { t } = useI18n();

  return (
    <div className="table-card mb-6 p-6">
      <h2 className="mb-5 text-xl font-semibold">{t.admin.pages.apps[0]}</h2>
      <p className="mb-4 text-sm text-slate-500">
        上传工作空间导出的应用或连接器 zip，后台会发布到七牛云并进入应用商店目录。
      </p>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <Field label="App ID" name="appId" placeholder="stock-research-dashboard" required />
        <Field label="Name" name="name" placeholder="股票投研看板" required />
        <Field label="Version" name="version" defaultValue="1.0.0" required />
        <SelectField label="Category" name="category" defaultValue="productivity" options={["productivity", "office", "connectors", "data", "finance", "creative", "developer", "business", "education"]} />
        <SelectField label="App type" name="appType" defaultValue="workspace" options={["workspace", "template", "tool", "dashboard", "connector"]} />
        <SelectField label="Risk" name="riskLevel" defaultValue="low" options={["low", "medium", "high"]} />
        <div className="lg:col-span-3">
          <Field label="App artifact zip" name="artifact" type="file" required />
        </div>
        <Field label="Min app version" name="minAppVersion" placeholder="0.1.43" />
        <SelectField label="Channel" name="channel" defaultValue="stable" options={["stable", "beta", "experimental"]} />
        <Field label="Publisher" name="publisher" defaultValue="Lily Workbench" />
        <Field label="Source repo" name="sourceRepo" placeholder="lily-workbench/apps" />
        <Field label="Tags" name="tags" placeholder="stocks,research,dashboard" />
        <Field label="Runtime deps" name="requiredRuntimePacks" placeholder="quant-runtime,browser-runtime" />
        <Field label="Skill deps" name="requiredSkillPackages" placeholder="lily-research-synthesis,lily-ui-quality" />
        <div className="lg:col-span-3">
          <Field label="Summary" name="summary" placeholder="输入股票代码，生成行情、财报、估值和风险摘要。" required />
        </div>
        <div className="lg:col-span-3">
          <TextAreaField label="Description" name="description" rows={4} placeholder="说明这个应用解决什么问题、需要什么输入、会输出什么结果、有哪些限制。" />
        </div>
        <div className="lg:col-span-4">
          <Field label="Notes" name="notes" placeholder="本版本更新说明" />
        </div>
        <input type="hidden" name="entryKind" value="zip" />
        <div className="flex items-end">
          <CheckboxField label="Featured" name="featured" />
        </div>
        <div className="flex items-end">
          <CheckboxField label="Disabled" name="disabled" />
        </div>
        <div className="flex items-end">
          <SubmitButton disabled={pending}>{pending ? "..." : t.admin.pages.apps[0]}</SubmitButton>
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
