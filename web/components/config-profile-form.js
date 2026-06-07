"use client";

import { useActionState, useMemo, useState } from "react";
import { createConfigProfileAction } from "../app/admin/actions";
import { CheckboxField, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };
const defaultConfig = {
  models: {
    activePresetId: "deepseek-gateway",
    presets: [
      {
        id: "deepseek-gateway",
        label: "DeepSeek Gateway",
        description: "通过 Lily 服务端透传 DeepSeek Anthropic-compatible endpoint。",
        env: {
          LILY_API_BASE_URL: "/llm/deepseek",
          LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          LILY_GATEWAY_PROVIDER: "deepseek",
          LILY_MODEL: "deepseek-v4-pro[1m]",
          LILY_MODEL_HAIKU: "deepseek-v4-flash",
          LILY_MODEL_SONNET: "deepseek-v4-pro[1m]",
          LILY_MODEL_OPUS: "deepseek-v4-pro[1m]",
          LILY_SUBAGENT_MODEL: "deepseek-v4-flash",
        },
      },
      {
        id: "qwen-gateway",
        label: "Qwen Gateway",
        description: "通过 Lily 服务端透传阿里 DashScope Anthropic-compatible endpoint。",
        env: {
          LILY_API_BASE_URL: "/llm/dashscope",
          LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          LILY_GATEWAY_PROVIDER: "dashscope",
          LILY_MODEL: "qwen3-coder-plus",
          LILY_MODEL_HAIKU: "qwen3-coder-plus",
          LILY_MODEL_SONNET: "qwen3-coder-plus",
          LILY_MODEL_OPUS: "qwen3-coder-plus",
          LILY_SUBAGENT_MODEL: "qwen3-coder-plus",
        },
      },
      {
        id: "kimi-gateway",
        label: "Kimi Gateway",
        description: "通过 Lily 服务端透传 Kimi/Moonshot Anthropic-compatible endpoint。",
        env: {
          LILY_API_BASE_URL: "/llm/kimi",
          LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          LILY_GATEWAY_PROVIDER: "kimi",
          LILY_MODEL: "kimi-k2.5",
          LILY_MODEL_HAIKU: "kimi-k2.5",
          LILY_MODEL_SONNET: "kimi-k2.5",
          LILY_MODEL_OPUS: "kimi-k2.5",
          LILY_SUBAGENT_MODEL: "kimi-k2.5",
        },
      },
      {
        id: "glm-gateway",
        label: "GLM Gateway",
        description: "通过 Lily 服务端透传 Z.AI/GLM Anthropic-compatible endpoint。",
        env: {
          LILY_API_BASE_URL: "/llm/glm",
          LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          LILY_GATEWAY_PROVIDER: "glm",
          LILY_MODEL: "glm-4.7",
          LILY_MODEL_HAIKU: "glm-4.5-air",
          LILY_MODEL_SONNET: "glm-4.7",
          LILY_MODEL_OPUS: "glm-4.7",
          LILY_SUBAGENT_MODEL: "glm-4.5-air",
        },
      },
      {
        id: "litellm-gateway",
        label: "LiteLLM Gateway",
        description: "通过 Lily 服务端转发到 LiteLLM，由 LiteLLM 适配自建或 OpenAI-compatible 模型。",
        env: {
          LILY_API_BASE_URL: "/llm/litellm",
          LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          LILY_GATEWAY_PROVIDER: "litellm",
          LILY_MODEL: "local-qwen",
          LILY_MODEL_HAIKU: "local-qwen-fast",
          LILY_MODEL_SONNET: "local-qwen",
          LILY_MODEL_OPUS: "local-qwen-strong",
          LILY_SUBAGENT_MODEL: "local-qwen-fast",
        },
      },
      {
        id: "local-anthropic-gateway",
        label: "Local Anthropic Gateway",
        description: "通过 Lily 服务端直连客户自建的 Anthropic-compatible 模型网关。",
        env: {
          LILY_API_BASE_URL: "/llm/local",
          LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
          LILY_GATEWAY_PROVIDER: "local",
          LILY_MODEL: "local-qwen",
          LILY_MODEL_HAIKU: "local-qwen",
          LILY_MODEL_SONNET: "local-qwen",
          LILY_MODEL_OPUS: "local-qwen",
          LILY_SUBAGENT_MODEL: "local-qwen",
        },
      },
    ],
  },
  tools: {
    pluginRegistryUrl: "/api/plugins/registry",
  },
  policy: {
    permissionMode: "default",
  },
  runtime: {
    env: {
      API_TIMEOUT_MS: "300000",
      VISION_MODEL: "qwen-vl-plus",
    },
  },
};

const formLabels = {
  zh: {
    templateTitle: "常用模板",
    templateDesc: "先选择一个网关或直连模板，再按全局、授权或设备下发。",
    advanced: "高级 JSON 配置",
    advancedDesc: "模型、插件入口和权限策略最终都会以这份 JSON 下发到客户端。",
    useTemplate: "使用模板",
  },
  en: {
    templateTitle: "Templates",
    templateDesc: "Pick a gateway or direct template, then deliver it globally, by license, or by device.",
    advanced: "Advanced JSON config",
    advancedDesc: "Models, plugin registry, and policy are delivered to clients as this JSON object.",
    useTemplate: "Use template",
  },
  ar: {
    templateTitle: "القوالب",
    templateDesc: "اختر قالب بوابة أو اتصال مباشر ثم أرسله عاماً أو حسب الترخيص أو الجهاز.",
    advanced: "JSON متقدم",
    advancedDesc: "تُرسل النماذج وسجل الإضافات والسياسات إلى العميل بهذه البنية.",
    useTemplate: "استخدم القالب",
  },
};

function profileConfigForPreset(preset) {
  return {
    ...defaultConfig,
    models: {
      activePresetId: preset.id,
      presets: [preset],
    },
  };
}

function initialDraft() {
  const preset = defaultConfig.models.presets[0];
  return {
    id: "global-default",
    name: "Global default model config",
    scope: "global",
    targetId: "",
    priority: "0",
    rolloutPercent: "100",
    config: JSON.stringify(defaultConfig, null, 2),
    selectedPresetId: preset?.id || "",
  };
}

export function ConfigProfileForm() {
  const [state, action, pending] = useActionState(createConfigProfileAction, initialState);
  const { locale, t } = useI18n();
  const copy = t.admin.configProfiles;
  const helper = formLabels[locale] || formLabels.zh;
  const [draft, setDraft] = useState(initialDraft);
  const presets = useMemo(() => defaultConfig.models.presets, []);

  function updateField(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  function applyPreset(preset) {
    setDraft((current) => ({
      ...current,
      id: `${preset.id}-global`,
      name: preset.label,
      scope: "global",
      targetId: "",
      priority: preset.id.includes("direct") ? "10" : "20",
      rolloutPercent: "100",
      selectedPresetId: preset.id,
      config: JSON.stringify(profileConfigForPreset(preset), null, 2),
    }));
  }

  return (
    <div className="table-card mb-6 p-6">
      <div className="mb-5 flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{copy.formTitle}</h2>
        <p className="text-sm text-slate-500">{copy.formDesc}</p>
      </div>
      <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-col gap-1">
          <div className="font-semibold text-slate-950">{helper.templateTitle}</div>
          <div className="text-sm text-slate-500">{helper.templateDesc}</div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`rounded-xl border bg-white p-4 text-left transition hover:border-brand hover:shadow-sm ${
                draft.selectedPresetId === preset.id ? "border-brand ring-2 ring-brand/10" : "border-slate-200"
              }`}
              onClick={() => applyPreset(preset)}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-slate-950">{preset.label}</div>
                <span className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand">{helper.useTemplate}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-500">{preset.description}</p>
              <div className="mt-3 truncate font-mono text-xs text-slate-400">{preset.env?.LILY_API_BASE_URL || "-"}</div>
            </button>
          ))}
        </div>
      </div>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">{copy.id}</span>
          <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" name="id" value={draft.id} onChange={(event) => updateField("id", event.target.value)} required />
        </label>
        <div className="lg:col-span-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">{copy.name}</span>
            <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" name="name" value={draft.name} onChange={(event) => updateField("name", event.target.value)} placeholder={copy.namePlaceholder} required />
          </label>
        </div>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">{copy.scope}</span>
          <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" name="scope" value={draft.scope} onChange={(event) => updateField("scope", event.target.value)}>
            {["global", "license", "device"].map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">{copy.targetId}</span>
          <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" name="targetId" value={draft.targetId} onChange={(event) => updateField("targetId", event.target.value)} placeholder="license id / device id" />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">{copy.priority}</span>
          <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" name="priority" type="number" value={draft.priority} onChange={(event) => updateField("priority", event.target.value)} />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">{copy.rolloutPercent}</span>
          <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand" name="rolloutPercent" type="number" value={draft.rolloutPercent} onChange={(event) => updateField("rolloutPercent", event.target.value)} />
        </label>
        <div className="lg:col-span-6">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">{helper.advanced}</span>
            <span className="mb-2 block text-xs text-slate-500">{helper.advancedDesc}</span>
            <textarea
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm outline-none focus:border-brand"
              name="config"
              value={draft.config}
              onChange={(event) => updateField("config", event.target.value)}
              rows={12}
              required
            />
          </label>
        </div>
        <div className="flex items-end">
          <CheckboxField label={copy.disabled} name="disabled" />
        </div>
        <div className="flex items-end lg:col-span-2">
          <SubmitButton disabled={pending}>{pending ? "..." : copy.save}</SubmitButton>
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
