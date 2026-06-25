"use client";

import { useActionState, useState } from "react";
import { createModelProviderAction, deleteModelProviderAction } from "../app/admin/actions";
import { SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const labels = {
  zh: {
    title: "模型供应商",
    desc: "在这里配置每个模型供应商的地址和密钥。密钥只存服务端(加密),客户端永远只拿短期 token——网关用这里的密钥去连模型。下面配置模型时直接选这里的供应商即可,不用再手输密钥。",
    id: "供应商 ID",
    idHelp: "小写字母/数字,如 deepseek、my-glm。也是网关路径 /llm/<ID>。",
    label: "名称",
    type: "协议",
    baseUrl: "接口地址",
    apiKey: "密钥",
    apiKeyHelp: "新建时填;编辑时留空表示不修改。",
    apiKeyKeep: "(留空=不改)",
    defaultModel: "默认模型",
    models: "可选模型",
    modelsHelp: "逗号分隔。整个列表都会下发，用户可在客户端切换；「默认模型」是初始选中项（须在列表内，留空则取第一个）。",
    save: "保存供应商",
    keySet: "已设密钥",
    noKey: "未设密钥",
    disabled: "停用",
    remove: "删除",
    empty: "还没有供应商。也可继续用服务端 env 配置的供应商。",
    edit: "编辑",
  },
  en: {
    title: "Model providers",
    desc: "Configure each provider's endpoint and key here. Keys are stored server-side (encrypted); clients only ever get a short-lived token — the gateway uses these keys to reach the model. When configuring a model below, just pick a provider from here; no key typing.",
    id: "Provider ID",
    idHelp: "lowercase letters/digits, e.g. deepseek, my-glm. Also the gateway path /llm/<ID>.",
    label: "Name",
    type: "Protocol",
    baseUrl: "Endpoint",
    apiKey: "API key",
    apiKeyHelp: "Set on create; leave blank when editing to keep it.",
    apiKeyKeep: "(blank = keep)",
    defaultModel: "Default model",
    models: "Available models",
    modelsHelp: "Comma-separated. The whole list is delivered so users can switch in the client; the default model is the initial pick (must be in the list; blank uses the first).",
    save: "Save provider",
    keySet: "key set",
    noKey: "no key",
    disabled: "Disable",
    remove: "Delete",
    empty: "No providers yet. Env-configured providers still work.",
    edit: "Edit",
  },
  ar: {
    title: "مزوّدو النماذج",
    desc: "اضبط عنوان ومفتاح كل مزوّد هنا. تُخزَّن المفاتيح على الخادم (مشفّرة)؛ يحصل العميل على رمز قصير فقط — تستخدم البوابة هذه المفاتيح للوصول للنموذج.",
    id: "معرّف المزوّد",
    idHelp: "أحرف/أرقام صغيرة، مثل deepseek. أيضاً مسار البوابة /llm/<ID>.",
    label: "الاسم",
    type: "البروتوكول",
    baseUrl: "العنوان",
    apiKey: "المفتاح",
    apiKeyHelp: "أدخله عند الإنشاء؛ اتركه فارغاً عند التعديل للإبقاء عليه.",
    apiKeyKeep: "(فارغ = إبقاء)",
    defaultModel: "النموذج الافتراضي",
    models: "النماذج المتاحة",
    modelsHelp: "مفصولة بفواصل.",
    save: "حفظ المزوّد",
    keySet: "مفتاح مضبوط",
    noKey: "بدون مفتاح",
    disabled: "تعطيل",
    remove: "حذف",
    empty: "لا مزوّدين بعد.",
    edit: "تعديل",
  },
};

const initialState = { ok: null, message: "" };

function fieldClass() {
  return "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10";
}

function Field({ label, children, help }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-slate-800">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-xs text-slate-500">{help}</span> : null}
    </label>
  );
}

export function ModelProvidersPanel({ providers = [] }) {
  const { locale } = useI18n();
  const copy = labels[locale] || labels.zh;
  const [state, action, pending] = useActionState(createModelProviderAction, initialState);
  const [draft, setDraft] = useState({ id: "", label: "", type: "anthropic", baseUrl: "", defaultModel: "", models: "", disabled: false });

  function edit(provider) {
    setDraft({
      id: provider.id,
      label: provider.label || "",
      type: provider.type || "anthropic",
      baseUrl: provider.base_url || "",
      defaultModel: provider.default_model || "",
      models: (provider.models || []).join(", "),
      disabled: !provider.enabled,
    });
  }
  function set(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  return (
    <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="border-b border-slate-100 pb-4">
        <h2 className="text-2xl font-semibold text-slate-950">{copy.title}</h2>
        <p className="mt-1 max-w-4xl text-sm text-slate-500">{copy.desc}</p>
      </div>

      <form action={action} className="mt-5 grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 md:grid-cols-2 xl:grid-cols-3">
        <Field label={copy.id} help={copy.idHelp}>
          <input className={fieldClass()} name="id" required value={draft.id} onChange={(e) => set("id", e.target.value)} placeholder="deepseek" />
        </Field>
        <Field label={copy.label}>
          <input className={fieldClass()} name="label" value={draft.label} onChange={(e) => set("label", e.target.value)} placeholder="DeepSeek" />
        </Field>
        <Field label={copy.type}>
          <select className={fieldClass()} name="type" value={draft.type} onChange={(e) => set("type", e.target.value)}>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="vision">vision</option>
            <option value="search">search</option>
          </select>
        </Field>
        <div className="md:col-span-2">
          <Field label={copy.baseUrl}>
            <input className={fieldClass()} name="baseUrl" value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://api.deepseek.com/anthropic" />
          </Field>
        </div>
        <Field label={`${copy.apiKey} ${copy.apiKeyKeep}`} help={copy.apiKeyHelp}>
          <input className={fieldClass()} name="apiKey" type="password" placeholder="sk-..." />
        </Field>
        <Field label={copy.defaultModel}>
          <input className={fieldClass()} name="defaultModel" value={draft.defaultModel} onChange={(e) => set("defaultModel", e.target.value)} placeholder="deepseek-v4-pro[1m]" />
        </Field>
        <div className="md:col-span-2 xl:col-span-3">
          <Field label={copy.models} help={copy.modelsHelp}>
            <input className={fieldClass()} name="models" value={draft.models} onChange={(e) => set("models", e.target.value)} placeholder="deepseek-v4-pro[1m], deepseek-v4-flash" />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-4 md:col-span-2 xl:col-span-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="disabled" checked={draft.disabled} onChange={(e) => set("disabled", e.target.checked)} />
            {copy.disabled}
          </label>
          <SubmitButton disabled={pending}>{pending ? "..." : copy.save}</SubmitButton>
        </div>
        {state?.message ? (
          <p className={`md:col-span-2 xl:col-span-3 text-sm ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p>
        ) : null}
      </form>

      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
        {providers.length ? (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start">{copy.id}</th>
                <th className="px-4 py-2 text-start">{copy.type}</th>
                <th className="px-4 py-2 text-start">{copy.baseUrl}</th>
                <th className="px-4 py-2 text-start">{copy.apiKey}</th>
                <th className="px-4 py-2 text-end" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {providers.map((provider) => (
                <tr key={provider.id} className={provider.enabled ? "" : "opacity-50"}>
                  <td className="px-4 py-2">
                    <span className="font-mono text-xs text-slate-700">{provider.id}</span>
                    {provider.label ? <span className="ms-2 text-slate-500">{provider.label}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{provider.type}</td>
                  <td className="px-4 py-2 max-w-[280px] truncate font-mono text-xs text-slate-500">{provider.base_url || "-"}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${provider.hasApiKey ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      {provider.hasApiKey ? copy.keySet : copy.noKey}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-end">
                    <button type="button" onClick={() => edit(provider)} className="me-3 text-xs font-semibold text-brand hover:underline">
                      {copy.edit}
                    </button>
                    <form action={deleteModelProviderAction} className="inline">
                      <input type="hidden" name="id" value={provider.id} />
                      <button type="submit" className="text-xs font-semibold text-red-600 hover:underline">{copy.remove}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-6 text-center text-sm text-slate-400">{copy.empty}</p>
        )}
      </div>
    </section>
  );
}
