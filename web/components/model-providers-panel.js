"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { createModelProviderAction, deleteModelProviderAction } from "../app/admin/actions";
import { SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const labels = {
  zh: {
    title: "模型供应商",
    desc: "这里管“厂商接入”。一个供应商可以有多个模型；下发规则只选择哪些供应商给客户端看，具体模型列表在这里维护。",
    providerSection: "供应商基础信息",
    accessSection: "服务端接入密钥",
    modelSection: "该供应商下的模型",
    id: "供应商 ID",
    idHelp: "小写字母/数字,如 deepseek、my-glm。也是网关路径 /llm/<ID>。",
    label: "名称",
    type: "协议",
    baseUrl: "接口地址",
    apiKey: "密钥",
    apiKeyHelp: "新建时填;编辑时留空表示不修改。",
    apiKeyKeep: "(留空=不改)",
    secretKey: "SecretKey",
    secretKeyHelp: "仅可灵(kling)需要:与 AccessKey(密钥)一起签发 JWT。留空=不改。",
    groupId: "GroupId",
    groupIdHelp: "仅 MiniMax 国内平台需要。非密钥,可见。",
    defaultModel: "供应商默认模型",
    defaultModelHelp: "客户端选择这个供应商时默认打开的模型。不是全局唯一模型。",
    models: "供应商可用模型列表",
    modelsHelp: "逗号分隔。同一个供应商下的模型都会下发，用户可在客户端切换；默认模型建议写在列表里，留空则取第一个。",
    modelCount: "模型数",
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
    desc: "This page manages provider integrations. One provider can expose multiple models; delivery rules only choose which providers the client can see.",
    providerSection: "Provider basics",
    accessSection: "Server-side credentials",
    modelSection: "Models under this provider",
    id: "Provider ID",
    idHelp: "lowercase letters/digits, e.g. deepseek, my-glm. Also the gateway path /llm/<ID>.",
    label: "Name",
    type: "Protocol",
    baseUrl: "Endpoint",
    apiKey: "API key",
    apiKeyHelp: "Set on create; leave blank when editing to keep it.",
    apiKeyKeep: "(blank = keep)",
    secretKey: "SecretKey",
    secretKeyHelp: "Kling only: signs the JWT together with the AccessKey (API key). Blank = keep.",
    groupId: "GroupId",
    groupIdHelp: "MiniMax (China) only. Non-secret, visible.",
    defaultModel: "Provider default model",
    defaultModelHelp: "The initial model when the client chooses this provider. This is not the only global model.",
    models: "Provider model list",
    modelsHelp: "Comma-separated. Every model under this provider is delivered so users can switch in the client; blank default uses the first.",
    modelCount: "Models",
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
    desc: "هذه الصفحة تدير اتصال المزوّدين. يمكن لكل مزوّد أن يحتوي عدة نماذج؛ قواعد الإرسال تختار المزوّدين الذين يراهم العميل فقط.",
    providerSection: "معلومات المزوّد",
    accessSection: "مفاتيح الخادم",
    modelSection: "نماذج هذا المزوّد",
    id: "معرّف المزوّد",
    idHelp: "أحرف/أرقام صغيرة، مثل deepseek. أيضاً مسار البوابة /llm/<ID>.",
    label: "الاسم",
    type: "البروتوكول",
    baseUrl: "العنوان",
    apiKey: "المفتاح",
    apiKeyHelp: "أدخله عند الإنشاء؛ اتركه فارغاً عند التعديل للإبقاء عليه.",
    apiKeyKeep: "(فارغ = إبقاء)",
    secretKey: "SecretKey",
    secretKeyHelp: "لـ Kling فقط: يوقّع الـ JWT مع AccessKey. فارغ = إبقاء.",
    groupId: "GroupId",
    groupIdHelp: "لـ MiniMax (الصين) فقط. غير سري.",
    defaultModel: "النموذج الافتراضي للمزوّد",
    defaultModelHelp: "النموذج الأولي عند اختيار هذا المزوّد. ليس نموذجاً عاماً وحيداً.",
    models: "قائمة نماذج المزوّد",
    modelsHelp: "مفصولة بفواصل. تُرسل كل نماذج هذا المزوّد للعميل.",
    modelCount: "عدد النماذج",
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

function SectionTitle({ title }) {
  return <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>;
}

function modelList(provider) {
  return Array.isArray(provider?.models) ? provider.models.filter(Boolean) : [];
}

function draftFromProvider(provider) {
  return {
    id: provider?.id || "",
    label: provider?.label || "",
    type: provider?.type || "anthropic",
    baseUrl: provider?.base_url || provider?.baseUrl || "",
    defaultModel: provider?.default_model || provider?.defaultModel || "",
    models: modelList(provider).join(", "),
    groupId: provider?.metadata?.groupId || "",
    disabled: provider ? !provider.enabled : false,
  };
}

export function ModelProvidersPanel({ providers = [], initialProvider = null, showForm = true, showList = true }) {
  const { locale } = useI18n();
  const copy = labels[locale] || labels.zh;
  const [state, action, pending] = useActionState(createModelProviderAction, initialState);
  const [draft, setDraft] = useState(() => draftFromProvider(initialProvider));

  function set(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  return (
    <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="border-b border-slate-100 pb-4">
        <h2 className="text-2xl font-semibold text-slate-950">{copy.title}</h2>
        <p className="mt-1 max-w-4xl text-sm text-slate-500">{copy.desc}</p>
      </div>

      {showForm ? <form action={action} className="mt-5 grid gap-5 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="md:col-span-2 xl:col-span-3">
          <SectionTitle title={copy.providerSection} />
        </div>
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
            <option value="media">media</option>
          </select>
        </Field>
        <div className="md:col-span-2 xl:col-span-3">
          <Field label={copy.baseUrl}>
            <input className={fieldClass()} name="baseUrl" value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://api.deepseek.com/anthropic" />
          </Field>
        </div>

        <div className="border-t border-slate-200 pt-1 md:col-span-2 xl:col-span-3">
          <SectionTitle title={copy.modelSection} />
        </div>
        <Field label={copy.defaultModel} help={copy.defaultModelHelp}>
          <input className={fieldClass()} name="defaultModel" value={draft.defaultModel} onChange={(e) => set("defaultModel", e.target.value)} placeholder="deepseek-v4-pro[1m]" />
        </Field>
        <div className="md:col-span-2">
          <Field label={copy.models} help={copy.modelsHelp}>
            <input className={fieldClass()} name="models" value={draft.models} onChange={(e) => set("models", e.target.value)} placeholder="deepseek-v4-pro[1m], deepseek-v4-flash, deepseek-reasoner" />
          </Field>
        </div>

        <div className="border-t border-slate-200 pt-1 md:col-span-2 xl:col-span-3">
          <SectionTitle title={copy.accessSection} />
        </div>
        <Field label={`${copy.apiKey} ${copy.apiKeyKeep}`} help={copy.apiKeyHelp}>
          <input className={fieldClass()} name="apiKey" type="password" placeholder="sk-..." />
        </Field>
        <Field label={`${copy.secretKey} ${copy.apiKeyKeep}`} help={copy.secretKeyHelp}>
          <input className={fieldClass()} name="secretKey" type="password" autoComplete="off" placeholder="kling secret" />
        </Field>
        <Field label={copy.groupId} help={copy.groupIdHelp}>
          <input className={fieldClass()} name="groupId" value={draft.groupId} onChange={(e) => set("groupId", e.target.value)} placeholder="minimax group id" />
        </Field>
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
      </form> : null}

      {showList ? <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
        {providers.length ? (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start">{copy.id}</th>
                <th className="px-4 py-2 text-start">{copy.type}</th>
                <th className="px-4 py-2 text-start">{copy.defaultModel}</th>
                <th className="px-4 py-2 text-start">{copy.modelCount}</th>
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
                  <td className="px-4 py-2 max-w-[220px] truncate font-mono text-xs text-slate-600">{provider.default_model || modelList(provider)[0] || "-"}</td>
                  <td className="px-4 py-2 text-slate-600">{modelList(provider).length}</td>
                  <td className="px-4 py-2 max-w-[280px] truncate font-mono text-xs text-slate-500">{provider.base_url || "-"}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${provider.hasApiKey ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      {provider.hasApiKey ? copy.keySet : copy.noKey}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-end">
                    <Link href={`/admin/config/providers/new?id=${encodeURIComponent(provider.id)}`} className="me-3 text-xs font-semibold text-brand hover:underline">
                      {copy.edit}
                    </Link>
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
      </div> : null}
    </section>
  );
}
