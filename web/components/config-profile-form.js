"use client";

import { useActionState } from "react";
import { createConfigProfileAction } from "../app/admin/actions";
import { CheckboxField, Field, SelectField, SubmitButton, TextAreaField } from "./admin-forms";
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
      {
        id: "direct-vendor",
        label: "Direct DeepSeek",
        description: "客户端直连 DeepSeek Anthropic-compatible endpoint，适合追求最低延迟的场景。",
        env: {
          LILY_API_BASE_URL: "https://api.deepseek.com/anthropic",
          LILY_API_KEY: "replace-with-deepseek-key",
          LILY_MODEL: "deepseek-v4-pro[1m]",
          LILY_MODEL_HAIKU: "deepseek-v4-flash",
          LILY_MODEL_SONNET: "deepseek-v4-pro[1m]",
          LILY_MODEL_OPUS: "deepseek-v4-pro[1m]",
          LILY_SUBAGENT_MODEL: "deepseek-v4-flash",
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
};

export function ConfigProfileForm() {
  const [state, action, pending] = useActionState(createConfigProfileAction, initialState);
  const { t } = useI18n();
  const copy = t.admin.configProfiles;

  return (
    <div className="table-card mb-6 p-6">
      <h2 className="mb-2 text-xl font-semibold">{copy.formTitle}</h2>
      <p className="mb-5 text-sm text-slate-500">{copy.formDesc}</p>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <Field label={copy.id} name="id" placeholder="global-default" required />
        <div className="lg:col-span-2">
          <Field label={copy.name} name="name" placeholder={copy.namePlaceholder} required />
        </div>
        <SelectField label={copy.scope} name="scope" defaultValue="global" options={["global", "license", "device"]} />
        <Field label={copy.targetId} name="targetId" placeholder="license id / device id" />
        <Field label={copy.priority} name="priority" type="number" defaultValue="0" />
        <Field label={copy.rolloutPercent} name="rolloutPercent" type="number" defaultValue="100" />
        <div className="lg:col-span-6">
          <TextAreaField
            label={copy.config}
            name="config"
            defaultValue={JSON.stringify(defaultConfig, null, 2)}
            rows={12}
            required
          />
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
